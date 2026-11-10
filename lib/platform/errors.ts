/**
 * Typed errors for the platform tier (`docs/decisions/platform-staff-auth.md`).
 *
 * The domain-`errors.ts` convention from `CLAUDE.md`'s 4-layer rule: the gate
 * and the platform services throw these, and the surface above translates them.
 */

/**
 * The acting principal is not platform staff — or is staff below the required
 * degree, or is not signed in at all.
 *
 * ⚠️ ONE error for all three cases, deliberately (ADR §2). "No session",
 * "session but no `platformRole`" and "role below `minimum`" are
 * INDISTINGUISHABLE to every caller, because a caller that could tell them
 * apart could probe for the existence of the admin area — and every renderer of
 * this error answers with the ordinary 404 the tenant guard already returns for
 * an unknown id. Do NOT add a `reason` field, a discriminant subclass, or a
 * message that names `/admin`: the message below is what would end up in a log
 * line, and it names neither the route nor which of the three it was.
 */
export class NotPlatformStaffError extends Error {
  readonly code = 'NOT_PLATFORM_STAFF';

  constructor() {
    super('The acting principal has no platform standing');
    this.name = 'NotPlatformStaffError';
  }
}

/**
 * A platform action whose reason policy is `required` was recorded without one
 * (ADR §3b — enforced in the service, not by the column, because a READ
 * legitimately has no reason and the column must stay nullable for it).
 *
 * Carries the action, unlike `NotPlatformStaffError`: this one is only ever
 * raised for a principal who has ALREADY passed the gate, so there is nothing
 * left to leak, and the operator who forgot the field needs to know which
 * action refused them.
 */
export class MissingAuditReasonError extends Error {
  readonly code = 'MISSING_AUDIT_REASON';

  constructor(readonly action: string) {
    super(`The platform action "${action}" requires a stated reason`);
    this.name = 'MissingAuditReasonError';
  }
}

/**
 * A `withPlatformWrite` transaction finished without recording a single audit
 * row (Story MOTIR-7662). The transaction is rolled back: a platform write that
 * would commit with no row in the chain is a defect in the caller, never a
 * state to persist (`docs/decisions/platform-staff-auth.md` §3a).
 */
export class PlatformWriteUnauditedError extends Error {
  readonly code = 'PLATFORM_WRITE_UNAUDITED';

  constructor() {
    super('A platform write transaction recorded no audit row');
    this.name = 'PlatformWriteUnauditedError';
  }
}

/**
 * The account an operator asked for does not exist (MOTIR-1167).
 *
 * Carries the id, like `MissingAuditReasonError` and unlike
 * `NotPlatformStaffError`: this one is only ever raised for a principal who has
 * already passed the gate, so there is nothing left to leak. The operator typed
 * or followed a stale id and needs to know which one missed.
 *
 * ⚠️ It is NOT the 404 posture. The gate's 404 says "this route does not
 * exist"; this says "this ACCOUNT does not exist", to somebody already inside
 * the console. Rendering it as the app's `notFound()` is correct and is what the
 * drill-down does — the two answers coincide on the screen and mean different
 * things, which is why they are different types here.
 */
export class PlatformUserNotFoundError extends Error {
  readonly code = 'PLATFORM_USER_NOT_FOUND';

  constructor(readonly userId: string) {
    super(`No account with id "${userId}"`);
    this.name = 'PlatformUserNotFoundError';
  }
}

/**
 * A suspend was asked for on an already-suspended account, or an unsuspend on
 * one that is not suspended (MOTIR-1167).
 *
 * The state is read and re-checked INSIDE the write transaction under a row
 * lock, so this is a genuine lost race between two operators rather than a
 * stale-page nuisance: without the lock, two concurrent suspends would each
 * read "open", each write, and the audit log would carry two suspensions of one
 * account with the second one's reason silently winning the column.
 */
export class PlatformSuspensionStateError extends Error {
  readonly code = 'PLATFORM_SUSPENSION_STATE';

  constructor(readonly suspended: boolean) {
    super(
      suspended ? 'That account is already suspended' : 'That account is not currently suspended',
    );
    this.name = 'PlatformSuspensionStateError';
  }
}

/**
 * The organization an operator asked for does not exist (MOTIR-4565).
 *
 * The org twin of `PlatformUserNotFoundError`, and it carries the id for the
 * same reason: it is only ever raised for a principal who has already passed the
 * gate, so there is nothing left to leak.
 *
 * ⚠️ AND IT IS NOT THE SAME ANSWER AS AN UNARMED READ. Before
 * `20260905120000_organization_internal_billing`, a cross-tenant read of
 * `organization` returned zero rows because no policy admitted it — which
 * produces this error while meaning something entirely different. The arms are
 * what make "no rows" mean "no such organization"; if this ever starts firing
 * for an org that plainly exists, read the policy set before reading the id.
 */
export class PlatformOrganizationNotFoundError extends Error {
  readonly code = 'PLATFORM_ORGANIZATION_NOT_FOUND';

  constructor(readonly organizationId: string) {
    super(`No organization with id "${organizationId}"`);
    this.name = 'PlatformOrganizationNotFoundError';
  }
}

/**
 * A classify was asked for on an already-internal org, or an unclassify on one
 * that is not classified (MOTIR-4565).
 *
 * The org twin of `PlatformSuspensionStateError`, and the same genuine race
 * rather than a stale-page nuisance: the state is read and re-checked INSIDE the
 * write transaction under a row lock, so this fires when two operators acted on
 * one org at once. Without the lock both would read "not classified", both would
 * write, and the audit log would carry two classifications of one org while only
 * one of them describes a change that happened.
 */
export class PlatformClassificationStateError extends Error {
  readonly code = 'PLATFORM_CLASSIFICATION_STATE';

  constructor(readonly internalBilling: boolean) {
    super(
      internalBilling
        ? 'That organization is already classified as internal billing'
        : 'That organization is not currently classified as internal billing',
    );
    this.name = 'PlatformClassificationStateError';
  }
}

/**
 * A suspend of an organization that is already suspended, or a reactivate of
 * one that is not (MOTIR-748). Decided under the row lock, so two operators
 * racing produce one write and one of these — never two audit rows for one
 * change. Thrown inside the platform transaction, so it rolls the audit row back.
 */
export class PlatformOrganizationSuspensionStateError extends Error {
  readonly code = 'PLATFORM_ORGANIZATION_SUSPENSION_STATE';

  constructor(readonly suspended: boolean) {
    super(
      suspended
        ? 'That organization is already suspended'
        : 'That organization is not currently suspended',
    );
    this.name = 'PlatformOrganizationSuspensionStateError';
  }
}

/**
 * A kill-switch flip named a key that is not in the registry (MOTIR-750) —
 * flags are a CLOSED set (`lib/featureFlags/registry.ts`), never free-form.
 * Thrown before the transaction opens, so it leaves no audit row.
 */
export class PlatformUnknownFeatureFlagError extends Error {
  readonly code = 'PLATFORM_UNKNOWN_FEATURE_FLAG';

  constructor(readonly key: string) {
    super(`"${key}" is not a known kill-switch`);
    this.name = 'PlatformUnknownFeatureFlagError';
  }
}

/**
 * A kill-switch flip to the state the switch is already in (MOTIR-750) —
 * decided under the organization row lock, so two operators racing produce one
 * change and one refusal, never two audit rows for one change.
 */
export class PlatformFeatureFlagStateError extends Error {
  readonly code = 'PLATFORM_FEATURE_FLAG_STATE';

  constructor(
    readonly key: string,
    readonly enabled: boolean,
  ) {
    super(`The ${key} switch is already ${enabled ? 'on' : 'off'} for that organization`);
    this.name = 'PlatformFeatureFlagStateError';
  }
}

/**
 * A planner-model save named the model the audience already holds (MOTIR-7227).
 *
 * Refused BEFORE the audited transaction opens, so the trail never records a
 * change that changed nothing — the same reason `PlatformClassificationStateError`
 * exists, one surface over.
 */
export class PlannerModelUnchangedError extends Error {
  readonly code = 'PLANNER_MODEL_UNCHANGED';

  constructor(
    readonly audience: string,
    readonly model: string,
  ) {
    super(`The ${audience} audience already plans with "${model}"`);
    this.name = 'PlannerModelUnchangedError';
  }
}

/** A function-default save named a function that is not Guide, Debug or Ask (MOTIR-10844). */
export class PlannerFunctionUnknownError extends Error {
  readonly code = 'PLANNER_FUNCTION_UNKNOWN';

  constructor(readonly fn: string) {
    super(`"${fn}" is not a planning-side function with a platform default`);
    this.name = 'PlannerFunctionUnknownError';
  }
}

/** A run-side default save named a key that is not one of the six (MOTIR-10844). */
export class RunModelDefaultKeyUnknownError extends Error {
  readonly code = 'RUN_MODEL_DEFAULT_KEY_UNKNOWN';

  constructor(readonly key: string) {
    super(`"${key}" is not a run-side default`);
    this.name = 'RunModelDefaultKeyUnknownError';
  }
}

/** A Guide / Debug / Ask default save named the value already stored (MOTIR-10844).
 *  `model` null is "inherit the audience's Planning model". */
export class PlannerFunctionModelUnchangedError extends Error {
  readonly code = 'PLANNER_FUNCTION_MODEL_UNCHANGED';

  constructor(
    readonly fn: string,
    readonly model: string | null,
  ) {
    super(
      model === null
        ? `${fn} already inherits the audience's planning model`
        : `${fn} already runs on "${model}"`,
    );
    this.name = 'PlannerFunctionModelUnchangedError';
  }
}

/** A run-side default save named the value already stored (MOTIR-10844), read before
 *  the write or answered by motir-ai's own no-op (`audit: null`). */
export class RunModelDefaultUnchangedError extends Error {
  readonly code = 'RUN_MODEL_DEFAULT_UNCHANGED';

  constructor(
    readonly key: string,
    readonly model: string | null,
  ) {
    super(
      model === null
        ? `The ${key} default already inherits`
        : `The ${key} default is already "${model}"`,
    );
    this.name = 'RunModelDefaultUnchangedError';
  }
}

/** A review-model save named the value already stored (MOTIR-10632). `model` null is
 *  "same as the planning model". */
export class PlannerReviewModelUnchangedError extends Error {
  readonly code = 'PLANNER_REVIEW_MODEL_UNCHANGED';

  constructor(readonly model: string | null) {
    super(
      model === null
        ? 'The dry-run review already follows the planning model'
        : `The dry-run review already runs on "${model}"`,
    );
    this.name = 'PlannerReviewModelUnchangedError';
  }
}

/** A planner-model save named an audience that is not one of the three (MOTIR-7227). */
export class PlannerAudienceUnknownError extends Error {
  readonly code = 'PLANNER_AUDIENCE_UNKNOWN';

  constructor(readonly audience: string) {
    super(`"${audience}" is not a planning audience — expected customer, meta or internal`);
    this.name = 'PlannerAudienceUnknownError';
  }
}

/** A planning-model list add or remove named no model (MOTIR-7524) — refused before motir-ai is asked. */
export class PlannerModelListModelMissingError extends Error {
  readonly code = 'PLANNER_MODEL_LIST_MODEL_MISSING';

  constructor() {
    super('Name the model to add to or remove from the planning-model list.');
    this.name = 'PlannerModelListModelMissingError';
  }
}

/** One project whose hosted-model override names a model, and at which levels (MOTIR-7525). */
export interface RunModelProjectUse {
  projectKey: string;
  projectName: string;
  levels: ('trivial' | 'low' | 'medium' | 'high')[];
}

/**
 * A run-model list REMOVE named a model still in use (Story MOTIR-7521 ·
 * MOTIR-7525): a live project overrides a level to it, or motir-ai's platform
 * default for a level is it. Removing it would leave those runs on a model the
 * list no longer allows, so it is refused, naming every use, before the audited
 * transaction commits.
 */
export class RunModelInUseError extends Error {
  readonly code = 'RUN_MODEL_IN_USE';

  constructor(
    readonly model: string,
    readonly projects: readonly RunModelProjectUse[],
    readonly platformLevels: readonly ('trivial' | 'low' | 'medium' | 'high')[],
    /** The run-side platform defaults set to it (MOTIR-10844): review agent, design run. */
    readonly platformRoles: readonly ('review' | 'design')[] = [],
  ) {
    const uses = [
      ...(platformLevels.length > 0
        ? [`the platform default for ${platformLevels.join(', ')}`]
        : []),
      ...platformRoles.map((r) =>
        r === 'review' ? 'the platform review-agent default' : 'the platform design-run default',
      ),
      ...projects.map((p) => `${p.projectKey} for ${p.levels.join(', ')}`),
    ];
    super(`"${model}" is in use: ${uses.join('; ')}`);
    this.name = 'RunModelInUseError';
  }
}

/** A run-model list ADD named a model motir-ai does not offer for hosted runs right now (MOTIR-7525). */
export class RunModelNotOfferedError extends Error {
  readonly code = 'RUN_MODEL_NOT_OFFERED';

  constructor(readonly model: string) {
    super(`"${model}" is not offered for hosted runs by motir-ai right now`);
    this.name = 'RunModelNotOfferedError';
  }
}

/** A run-model list ADD named a model already listed — refused so the trail never records a non-change (MOTIR-7525). */
export class RunModelAlreadyListedError extends Error {
  readonly code = 'RUN_MODEL_ALREADY_LISTED';

  constructor(readonly model: string) {
    super(`"${model}" is already on the hosted-run model list`);
    this.name = 'RunModelAlreadyListedError';
  }
}

/** A run-model list REMOVE named a model that is not listed (MOTIR-7525). */
export class RunModelNotListedError extends Error {
  readonly code = 'RUN_MODEL_NOT_LISTED';

  constructor(readonly model: string) {
    super(`"${model}" is not on the hosted-run model list`);
    this.name = 'RunModelNotListedError';
  }
}

/**
 * The workspace page's pair (MOTIR-7295) names no workspace OF THAT ORGANIZATION —
 * a missing workspace, or one belonging to another org. Thrown inside the audited
 * read so it leaves no audit row; the page answers 404.
 */
export class PlatformWorkspaceNotFoundError extends Error {
  readonly code = 'PLATFORM_WORKSPACE_NOT_FOUND';

  constructor(readonly workspaceId: string) {
    super(`No workspace ${workspaceId} in this organization.`);
    this.name = 'PlatformWorkspaceNotFoundError';
  }
}

/**
 * A planning-lesson curate act would change nothing (MOTIR-1411): the edit names
 * the values already stored, the switch is already where it was asked to go, or
 * motir-ai answered `audit: null` because another write got there first. Thrown
 * INSIDE the audited transaction in the last case, so no row is left for it.
 */
export class PlatformLessonUnchangedError extends Error {
  readonly code = 'PLATFORM_LESSON_UNCHANGED';

  constructor(readonly lessonId: string) {
    super(`Lesson "${lessonId}" already holds that value — nothing to change`);
    this.name = 'PlatformLessonUnchangedError';
  }
}

/** A lesson edit that would blank a field, or a promote to a target the lesson cannot take. */
export class PlatformLessonInvalidError extends Error {
  readonly code = 'PLATFORM_LESSON_INVALID';

  constructor(readonly detail: string) {
    super(detail);
    this.name = 'PlatformLessonInvalidError';
  }
}

/**
 * An audit-log search was asked with an input that cannot be read (MOTIR-751)
 * — a cursor that is not one this service handed out, a date that does not
 * parse, a range that ends before it starts, or a verify range the wrong way
 * round. Carries the offending field: the principal has already passed the
 * `superadmin` gate, so there is nothing left to leak.
 */
export class PlatformAuditQueryInvalidError extends Error {
  readonly code = 'PLATFORM_AUDIT_QUERY_INVALID';

  constructor(readonly field: string) {
    super(`The audit-log query field "${field}" is not valid`);
    this.name = 'PlatformAuditQueryInvalidError';
  }
}

// ── Credit ops (MOTIR-747 · 10.3.2) ─────────────────────────────────────────
//
// The console's typed refusals for grant / adjust / change plan / the ledger
// read. Each is raised for a principal who has already passed the `superadmin`
// gate, so each carries what the operator needs to see — there is nothing left to
// leak. Every one of them is thrown BEFORE the audited transaction commits, so a
// refused credit op leaves no audit row (design rule 6: "the write and its audit
// row share one outcome").

/**
 * The amount is not one this operation accepts — a grant that is not a positive
 * integer, an adjustment that is zero or not an integer, or either beyond the
 * 32-bit range the ledger stores. Checked in core before anything is sent, so a
 * typo never reaches motir-ai or the trail.
 */
export class PlatformCreditAmountInvalidError extends Error {
  readonly code = 'PLATFORM_CREDIT_AMOUNT_INVALID';

  constructor(
    readonly kind: 'grant' | 'adjustment',
    readonly credits: number,
  ) {
    super(
      kind === 'grant'
        ? `A grant must be a positive whole number of credits (got ${credits})`
        : `An adjustment must be a non-zero whole number of credits (got ${credits})`,
    );
    this.name = 'PlatformCreditAmountInvalidError';
  }
}

/**
 * A LARGE grant (at or above `LARGE_GRANT_THRESHOLD_CREDITS`) arrived without the
 * org's slug typed back as its confirmation (design Panel 2b). Enforced in the
 * service as well as the dialog, because a Server Action is reachable without
 * the dialog.
 */
export class PlatformLargeGrantUnconfirmedError extends Error {
  readonly code = 'PLATFORM_LARGE_GRANT_UNCONFIRMED';

  constructor(
    readonly credits: number,
    readonly threshold: number,
  ) {
    super(
      `A grant of ${credits} credits is at or above ${threshold} and needs the organization's slug typed to confirm`,
    );
    this.name = 'PlatformLargeGrantUnconfirmedError';
  }
}

/**
 * An adjustment would take the org's balance below zero. Raised by core's own
 * pre-check against the balance the operator saw, and by motir-ai's authoritative
 * check under its ledger lock (`insufficient_balance:`) when the balance moved in
 * between. Nothing was written either way.
 */
export class PlatformCreditInsufficientBalanceError extends Error {
  readonly code = 'PLATFORM_CREDIT_INSUFFICIENT_BALANCE';

  constructor(
    readonly credits: number,
    readonly balanceCredits: number | null,
  ) {
    super(
      balanceCredits === null
        ? `An adjustment of ${credits} credits would take the balance below zero`
        : `An adjustment of ${credits} credits would take the balance of ${balanceCredits} below zero`,
    );
    this.name = 'PlatformCreditInsufficientBalanceError';
  }
}

/**
 * The credit service refused the operation as a STATE conflict: the action's
 * `requestId` was already spent on a different amount / tier / org / kind, or the
 * organization was offboarded in motir-ai (`org_erased: …`). Carries motir-ai's
 * detail verbatim. Nothing was written.
 */
export class PlatformCreditConflictError extends Error {
  readonly code = 'PLATFORM_CREDIT_CONFLICT';

  constructor(readonly detail: string) {
    super(`The credit service refused the operation: ${detail}`);
    this.name = 'PlatformCreditConflictError';
  }
}

/**
 * The credit service rejected the request as invalid (`validation_error`) — most
 * often an unknown `tierKey`, since core validates amounts before sending. Carries
 * motir-ai's detail verbatim. Nothing was written.
 */
export class PlatformCreditRejectedError extends Error {
  readonly code = 'PLATFORM_CREDIT_REJECTED';

  constructor(readonly detail: string) {
    super(`The credit service rejected the request: ${detail}`);
    this.name = 'PlatformCreditRejectedError';
  }
}

/**
 * The credit service could not be reached, timed out, or answered something that
 * is not its contract (design Panel 2f's "Couldn't reach the credit service.
 * Nothing was granted and nothing was recorded."). The audited transaction rolls
 * back with it, so that sentence is true.
 */
export class PlatformCreditServiceUnavailableError extends Error {
  readonly code = 'PLATFORM_CREDIT_SERVICE_UNAVAILABLE';

  constructor(readonly detail: string) {
    super(`The credit service is unavailable: ${detail}`);
    this.name = 'PlatformCreditServiceUnavailableError';
  }
}

/**
 * A WRITE was attempted inside a READ-ONLY staff "View as" session (MOTIR-749).
 *
 * Raised at the session chokepoint (`readSession`), before the request reaches
 * any service: a Server Action, or a non-GET API request, made while the
 * operator is viewing a tenant read-only. Nothing ran and nothing was written.
 * The cookie-session API doors answer it 403 `IMPERSONATION_READ_ONLY`.
 *
 * Not a `NotPlatformStaffError` cousin: the caller IS staff and the surface is
 * the tenant's, so there is no existence to hide — the refusal says what it is.
 */
export class ImpersonationReadOnlyError extends Error {
  readonly code = 'IMPERSONATION_READ_ONLY';

  constructor(readonly sessionId: string) {
    super('This is a read-only staff session: nothing can be changed in it.');
    this.name = 'ImpersonationReadOnlyError';
  }
}

/** Why an account cannot be viewed as (MOTIR-749) — each refused at START. */
export type ImpersonationIneligibility =
  /** The operator asked to view as themselves. */
  | 'self'
  /** The target holds platform standing — staff never impersonate staff. */
  | 'platform_staff'
  /** The account is suspended (MOTIR-1167): it cannot sign in, so there is nothing to see as it. */
  | 'suspended_account'
  /** The account's organization is suspended (MOTIR-748): its members are refused at the gate. */
  | 'suspended_organization'
  /** The account belongs to no workspace — there is no tenant to enter. */
  | 'no_workspace';

/**
 * The account cannot be viewed as (MOTIR-749) — see
 * {@link ImpersonationIneligibility}. Thrown inside the audited transaction, so
 * a refused start leaves no `user.impersonation_start` row.
 */
export class ImpersonationTargetIneligibleError extends Error {
  readonly code = 'IMPERSONATION_TARGET_INELIGIBLE';

  constructor(readonly ineligibility: ImpersonationIneligibility) {
    super(`This account cannot be viewed as: ${ineligibility}`);
    this.name = 'ImpersonationTargetIneligibleError';
  }
}

/**
 * The requested time-box or access mode is not one the console offers
 * (MOTIR-749, design Panel 4: Read-only | Full access, 15 / 30 / 60 minutes).
 * Enforced in the service because a Server Action is reachable without the
 * dialog — an "indefinite" session must be impossible, not merely undrawn.
 */
export class ImpersonationInvalidRequestError extends Error {
  readonly code = 'IMPERSONATION_INVALID_REQUEST';

  constructor(readonly detail: string) {
    super(`Invalid staff session request: ${detail}`);
    this.name = 'ImpersonationInvalidRequestError';
  }
}

/**
 * A new CREDENTIAL — a personal access token, a `motir login` device credential,
 * an OAuth / MCP connection — was about to be minted while a staff session
 * cookie was present (MOTIR-749). Refused in EVERY mode: a credential minted as
 * the customer would outlive the time-box and leave the session, which is the
 * one thing a staff session must never produce. Answered 403
 * `IMPERSONATION_CREDENTIAL_REFUSED` on the cookie API doors.
 */
export class ImpersonationCredentialRefusedError extends Error {
  readonly code = 'IMPERSONATION_CREDENTIAL_REFUSED';

  constructor() {
    super('A credential cannot be created inside a staff session.');
    this.name = 'ImpersonationCredentialRefusedError';
  }
}

/** One condition of the fleet readiness verdict that is not `met`, as the
 *  setting's refusal carries it (MOTIR-8714). */
export interface FleetOrgCiUnmetCondition {
  key: string;
  state: 'unmet' | 'unknown';
  reasonCode: string;
  message: string;
}

/**
 * Turning the fleet ON for a (project, org) pair was refused because the
 * readiness verdict is not ready (Story MOTIR-8699 · MOTIR-8714). Carries every
 * condition that is not `met`, so the console can name each one. Thrown BEFORE
 * any GitHub write and before the audited transaction, so nothing moved and no
 * audit row exists. Turning the fleet OFF never raises it.
 */
export class FleetOrgCiNotReadyError extends Error {
  readonly code = 'FLEET_ORG_CI_NOT_READY';

  constructor(
    readonly projectId: string,
    readonly org: string,
    readonly conditions: FleetOrgCiUnmetCondition[],
  ) {
    super(`The fleet is not ready for ${org}: ${conditions.map((c) => c.key).join(', ')} not met`);
    this.name = 'FleetOrgCiNotReadyError';
  }
}

/**
 * The fleet org CI setting was asked about a (project, org) pair the console
 * does not offer (MOTIR-8714) — not a project of the meta organisation, the
 * provisioning org itself, or an org holding none of the project's private
 * repositories. Refused before any GitHub call.
 */
export class FleetOrgCiTargetUnknownError extends Error {
  readonly code = 'FLEET_ORG_CI_TARGET_UNKNOWN';

  constructor(
    readonly projectId: string,
    readonly org: string,
  ) {
    super(`The fleet org CI setting is not offered for ${org} on project ${projectId}`);
    this.name = 'FleetOrgCiTargetUnknownError';
  }
}

/**
 * A GitHub read or write of the org's `MOTIR_RUNNER` variable failed while the
 * fleet org CI setting was being flipped (MOTIR-8714). Wraps the client's
 * `ActionsVariableApiError` or `OrgTargetAuthError` with the org, the HTTP
 * status (`null` when GitHub could not be reached) and the operation. Never a
 * token or a raw body. The stored state and the audit chain are unchanged.
 */
export class FleetOrgCiGithubWriteError extends Error {
  readonly code = 'FLEET_ORG_CI_GITHUB_WRITE_FAILED';

  constructor(
    readonly org: string,
    readonly status: number | null,
    readonly operation: 'read' | 'set' | 'delete',
  ) {
    super(
      status === null
        ? `GitHub could not be reached to ${operation} MOTIR_RUNNER on ${org}`
        : `GitHub refused to ${operation} MOTIR_RUNNER on ${org} (HTTP ${status})`,
    );
    this.name = 'FleetOrgCiGithubWriteError';
  }
}

/**
 * A fleet flip could not read or move ONE repository's CodeQL default setup
 * (MOTIR-10289). The same rule as {@link FleetOrgCiGithubWriteError}: nothing is
 * stored, no audit row is written, and whatever the flip had already moved on
 * GitHub is put back. `to` names the runner the flip was moving the repository
 * onto, so the operator reads which way it failed.
 */
export class FleetOrgCiCodeScanningError extends Error {
  readonly code = 'FLEET_ORG_CI_CODE_SCANNING_FAILED';

  constructor(
    readonly org: string,
    readonly repo: string,
    readonly status: number | null,
    readonly operation: 'read' | 'write',
    readonly to: 'fleet' | 'github_hosted',
  ) {
    const what =
      operation === 'read'
        ? `read the CodeQL default setup of ${org}/${repo}`
        : `move the CodeQL default setup of ${org}/${repo} to ${to === 'fleet' ? 'the fleet' : 'GitHub-hosted runners'}`;
    super(
      status === null
        ? `GitHub could not be reached to ${what}`
        : `GitHub refused to ${what} (HTTP ${status})`,
    );
    this.name = 'FleetOrgCiCodeScanningError';
  }
}

/**
 * A planner-finding triage write that changed nothing (Story MOTIR-10353 ·
 * MOTIR-10519): motir-ai answered `audit: null` — someone already set that
 * value — or a promote of a finding that is already a lesson. Thrown INSIDE the
 * audited transaction, so no `planner_finding.triage` row is left for it.
 */
export class PlannerFindingUnchangedError extends Error {
  readonly code = 'PLANNER_FINDING_UNCHANGED';

  constructor(readonly findingId: string) {
    super(`Planner finding "${findingId}" already holds that value — nothing to change`);
    this.name = 'PlannerFindingUnchangedError';
  }
}

/** A triage input refused before any motir-ai call; `field` names the offending input. */
export class PlannerFindingInvalidError extends Error {
  readonly code = 'PLANNER_FINDING_INVALID';

  constructor(
    readonly detail: string,
    readonly field?: string,
  ) {
    super(detail);
    this.name = 'PlannerFindingInvalidError';
  }
}

/**
 * A promote created the lesson but could not record it on the finding. The
 * lesson EXISTS: the caller must say so and must not create it again — the
 * service neither retries the create nor deletes the lesson.
 */
export class PlannerFindingLessonNotLinkedError extends Error {
  readonly code = 'PLANNER_FINDING_LESSON_NOT_LINKED';

  constructor(
    readonly findingId: string,
    readonly lessonId: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Lesson "${lessonId}" was created but planner finding "${findingId}" does not link it`,
      options,
    );
    this.name = 'PlannerFindingLessonNotLinkedError';
  }
}
