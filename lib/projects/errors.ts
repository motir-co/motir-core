// Typed errors for the projects domain. Kept in their own file so callers
// — route handlers, server actions, server components — can import them
// without pulling in the Prisma client.
//
// Per CLAUDE.md, services throw typed errors with stable string `code`s;
// route handlers translate those codes to HTTP status codes. The
// membership gate reuses NotAMemberError from lib/workspaces/errors.ts
// rather than duplicating it here.

export class IdentifierCollisionError extends Error {
  readonly code = 'IDENTIFIER_COLLISION' as const;
  constructor(identifier: string) {
    super(
      `Could not generate a unique project identifier after retries (last attempt: ${identifier}).`,
    );
    this.name = 'IdentifierCollisionError';
  }
}

// ── Edit project details + change key errors (Story 6.8 · Subtask 6.8.1) ─────
// The PATCH /api/projects/[key] + DELETE .../aliases/[alias] write path throws
// these; `projectErrorResponse` maps them:
//   InvalidProjectNameError / InvalidIdentifierError / IdentifierUnchangedError
//       / InvalidProjectImageError                           → 400
//   IdentifierTakenError / IdentifierReservedError           → 409
//   AliasNotFoundError                                       → 404
// (admin-gating reuses NotProjectAdminError → 403 and ProjectNotFoundError → 404
// from above / projectAccessService — no existence leak on a non-browser.)

export class InvalidProjectNameError extends Error {
  readonly code = 'INVALID_PROJECT_NAME' as const;
  constructor() {
    super('A project name is required and cannot be blank.');
    this.name = 'InvalidProjectNameError';
  }
}

// The public Overview/README body exceeds the maximum allowed length (Story
// 6.12 · Subtask 6.12.8). Project admins author it, but the field is a stored
// public-projection payload, so a generous server cap keeps a single edit from
// bloating the row / public read. Maps to 400.
export class ProjectOverviewTooLongError extends Error {
  readonly code = 'PROJECT_OVERVIEW_TOO_LONG' as const;
  constructor(readonly max: number) {
    super(`The project overview must be at most ${max} characters.`);
    this.name = 'ProjectOverviewTooLongError';
  }
}

// The public hero TAGLINE exceeds its maximum length (Story 6.16 · Subtask
// 6.16.3). The tagline rides the public projection, so a generous-but-bounded
// server cap keeps a single edit from bloating the hero. Maps to 400.
export class ProjectTaglineTooLongError extends Error {
  readonly code = 'PROJECT_TAGLINE_TOO_LONG' as const;
  constructor(readonly max: number) {
    super(`The project tagline must be at most ${max} characters.`);
    this.name = 'ProjectTaglineTooLongError';
  }
}

// The public hero TAGS are invalid (Story 6.16 · Subtask 6.16.3) — either too
// many tags (after trimming empties + de-duplicating) or a single tag that is
// too long. One typed error covers both causes; the `reason` distinguishes them
// for the surface's copy. Maps to 400.
export class ProjectTagsInvalidError extends Error {
  readonly code = 'PROJECT_TAGS_INVALID' as const;
  constructor(
    readonly reason: 'too_many' | 'tag_too_long',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectTagsInvalidError';
  }
}

// The new key is not a legal project key. STRICT (reject, don't normalize): an
// explicit admin key change must not silently pad/truncate a malformed key the
// way the create-time `normalizeIdentifier` does — renaming every issue to a key
// the admin didn't type would be a surprising, hard-to-undo mutation. The shape
// is the shipped column contract: 3–5 chars, uppercase A–Z / 0–9 (Jira likewise
// rejects a malformed key rather than coercing it — decision-ladder rung 1).
export class InvalidIdentifierError extends Error {
  readonly code = 'INVALID_IDENTIFIER' as const;
  constructor(identifier: string) {
    super(`"${identifier}" is not a valid project key (use 3–5 uppercase letters or digits).`);
    this.name = 'InvalidIdentifierError';
  }
}

// The new key equals the current one — a typed no-op so the surface can tell
// "nothing to change" apart from a real collision (and never runs the rewrite).
export class IdentifierUnchangedError extends Error {
  readonly code = 'IDENTIFIER_UNCHANGED' as const;
  constructor(identifier: string) {
    super(`The project key is already "${identifier}".`);
    this.name = 'IdentifierUnchangedError';
  }
}

// The key is the LIVE identifier of another project in the workspace.
export class IdentifierTakenError extends Error {
  readonly code = 'IDENTIFIER_TAKEN' as const;
  constructor(identifier: string) {
    super(`Another project in this workspace already uses the key "${identifier}".`);
    this.name = 'IdentifierTakenError';
  }
}

// The key is RESERVED by another project's previous-key alias. Distinct from
// IdentifierTakenError so the UI can show distinct copy (the 6.8.3 design): a
// reserved key is freed only by deleting that project or releasing its alias.
export class IdentifierReservedError extends Error {
  readonly code = 'IDENTIFIER_RESERVED' as const;
  constructor(identifier: string) {
    super(`The key "${identifier}" is reserved by another project's previous key.`);
    this.name = 'IdentifierReservedError';
  }
}

// A project `image` reference that is not one of OUR public-bucket objects under
// THIS project's own `projects/<projectId>/` prefix (MOTIR-2676). The value the
// caller sent is deliberately NOT echoed: a rejected ref is by definition one
// this project may not point at, and reflecting it turns the error into an oracle
// for probing another tenant's key space.
export class InvalidProjectImageError extends Error {
  readonly code = 'INVALID_PROJECT_IMAGE' as const;
  constructor() {
    super('A project image must be an uploaded asset belonging to this project.');
    this.name = 'InvalidProjectImageError';
  }
}

// No alias with this key belongs to the project (release of a non-existent
// previous key). 404 — indistinguishable shape from a missing resource.
export class AliasNotFoundError extends Error {
  readonly code = 'ALIAS_NOT_FOUND' as const;
  constructor(identifier: string) {
    super(`No previous key "${identifier}" is reserved for this project.`);
    this.name = 'AliasNotFoundError';
  }
}

// The project AI-planning settings patch is invalid (Story 7.13 · Subtask
// MOTIR-915) — an out-of-range `aiAutoPlanThreshold` / `aiSprintLengthDays`, a
// non-integer where an integer is required. The bounds live in `lib/projectAiSettings/limits.ts`; the value is
// REJECTED, never silently clamped at the DB, so a settings panel that sends a
// bad number learns about it instead of quietly persisting something else.
// `field` lets the panel attach the message to the right control. The entity is
// well-formed but the value semantics are wrong → 422 (the same family as
// `InvalidScaleConfigError`).
export class InvalidAiSettingsError extends Error {
  readonly code = 'INVALID_AI_SETTINGS' as const;
  constructor(
    readonly field: 'aiAutoPlanThreshold' | 'aiSprintLengthDays',
    message: string,
  ) {
    super(message);
    this.name = 'InvalidAiSettingsError';
  }
}

/**
 * A status-automation patch (Story MOTIR-1615 · MOTIR-1618) carried a non-boolean
 * for one of the two switches. They are plain on/off flags, so there is nothing
 * to coerce — a `"true"` string or a `1` is a caller bug, and silently truthy-ing
 * it would turn a typo into a project-wide behaviour change. → 422, alongside
 * `InvalidAiSettingsError`. Carries `field` so the panel can slot the message
 * under the offending control.
 */
export class InvalidStatusAutomationSettingsError extends Error {
  readonly code = 'INVALID_STATUS_AUTOMATION_SETTINGS' as const;
  constructor(readonly field: 'autoRollupParentStatus' | 'autoCompleteChildrenOnParentDone') {
    super(`"${field}" must be true or false.`);
    this.name = 'InvalidStatusAutomationSettingsError';
  }
}

/**
 * A merge-mode write carrying a value outside `PrMergeMode` (MOTIR-5179). The
 * two members are a closed vocabulary; a typo must not become a project's merge
 * policy. → 422.
 */
export class InvalidPrMergeModeError extends Error {
  readonly code = 'INVALID_PR_MERGE_MODE' as const;
  constructor(readonly value: unknown) {
    super(`"${String(value)}" is not a merge mode (auto or manual).`);
    this.name = 'InvalidPrMergeModeError';
  }
}

/**
 * The REVIEW AGENT and AUTO merging exclude each other (Story MOTIR-1626;
 * `docs/decisions/approval-gates.md` §12.2a, decided by the requester 2026-09-29):
 * turning the review agent ON in a project that merges automatically. Refused rather
 * than silently switching the merge mode for the person. → 409.
 */
export class ReviewAgentNeedsManualMergeError extends Error {
  readonly code = 'REVIEW_AGENT_NEEDS_MANUAL_MERGE' as const;
  constructor(readonly projectId: string) {
    super(
      'The review agent can be turned on only while this project asks before merging. Choose "Ask before merging" first.',
    );
    this.name = 'ReviewAgentNeedsManualMergeError';
  }
}

/**
 * The other half of §12.2a: choosing AUTO merging while the review agent is on. → 409.
 */
export class MergeModeReviewAgentOnError extends Error {
  readonly code = 'MERGE_MODE_REVIEW_AGENT_ON' as const;
  constructor(readonly projectId: string) {
    super(
      'This project cannot merge automatically while its review agent is on. Turn the review agent off first.',
    );
    this.name = 'MergeModeReviewAgentOnError';
  }
}

/**
 * A bug-destination write carrying something other than a folder id or `null`
 * (Story MOTIR-4927 · MOTIR-4938). `null` is a CHOICE — the project root — so it
 * is valid; a missing key, a number or an empty string is not. → 400.
 */
export class InvalidBugDestinationError extends Error {
  readonly code = 'INVALID_BUG_DESTINATION' as const;
  constructor(readonly value: unknown) {
    super('A bug destination is a folder id, or null for the project root.');
    this.name = 'InvalidBugDestinationError';
  }
}

export class ProjectNotFoundError extends Error {
  readonly code = 'PROJECT_NOT_FOUND' as const;
  constructor(projectId: string) {
    super(`Project ${projectId} not found.`);
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectWorkspaceMismatchError extends Error {
  readonly code = 'PROJECT_WORKSPACE_MISMATCH' as const;
  constructor(projectId: string, workspaceId: string) {
    super(`Project ${projectId} does not belong to workspace ${workspaceId}.`);
    this.name = 'ProjectWorkspaceMismatchError';
  }
}

// ── Project membership + access errors (Story 6.4 · Subtask 6.4.4) ──────────
// The management surface (add/remove member, set role, set access level) is
// gated to project admins (or the workspace owner/admin, who always pass). The
// route maps these to: NotProjectAdminError → 403, TargetNotWorkspaceMemberError
// / InvalidProjectRoleError / InvalidAccessModeError → 400, ProjectNotFoundError
// / NotAProjectMemberError → 404, AlreadyProjectMemberError / LastProjectAdminError
// → 409.

// The browse/edit access gate (Story 6.4 · Subtask 6.4.3). One typed error
// covers both denials; `kind` decides the HTTP mapping the route applies:
//   * `kind: 'browse'` → 404. A project the actor can't browse is HIDDEN — it
//     must be indistinguishable from a non-existent one (no existence leak,
//     same shape as ProjectNotFoundError / finding #26 / Jira private projects).
//   * `kind: 'edit'`   → 403. The actor CAN see the project (browse passed) but
//     is read-only on it (a viewer, or a plain member on a limited project), so
//     the project's existence is already known — a 403 "forbidden" is correct.
// Either way the stable `code` lets the UI (6.4.6) render the no-access / no-edit
// state instead of a crash.
export class ProjectAccessDeniedError extends Error {
  readonly code = 'PROJECT_ACCESS_DENIED' as const;
  constructor(
    projectId: string,
    readonly kind: 'browse' | 'edit',
  ) {
    super(
      kind === 'browse'
        ? `You do not have access to project ${projectId}.`
        : `You have read-only access to project ${projectId} and cannot make this change.`,
    );
    this.name = 'ProjectAccessDeniedError';
  }
}

export class NotProjectAdminError extends Error {
  readonly code = 'NOT_PROJECT_ADMIN' as const;
  constructor(projectId: string) {
    super(`You must be a project admin (or workspace owner/admin) to manage project ${projectId}.`);
    this.name = 'NotProjectAdminError';
  }
}

/**
 * The generic permission refusal (Story MOTIR-2256 · Subtask MOTIR-2293) — the
 * browser held the project but not the KEY the gate asked for. Carries
 * `permission` so a caller can say WHICH grant is missing rather than "forbidden".
 * Maps to 403 in `projectErrorResponse`, alongside `NotProjectAdminError`.
 *
 * ⚠️ `project:administer` is NOT thrown as this error — {@link
 * NotProjectAdminError} keeps that one. That is a deliberate COMPATIBILITY
 * BRANCH in `projectAccessService.assertPermission`: `NOT_PROJECT_ADMIN` is a
 * shipped wire code that `app/(authed)/settings/project/workflow/actions.ts`,
 * `lib/workflows/errors.ts` and `tests/components/components-settings-editor.test.tsx`
 * read by string. Splitting the umbrella must not change what any of them
 * receive. Remove the branch — and this note — once nothing reads the old code.
 */
export class PermissionDeniedError extends Error {
  readonly code = 'PERMISSION_DENIED' as const;
  constructor(
    projectId: string,
    readonly permission: string,
  ) {
    super(`You do not hold the "${permission}" permission on project ${projectId}.`);
    this.name = 'PermissionDeniedError';
  }
}

export class TargetNotWorkspaceMemberError extends Error {
  readonly code = 'TARGET_NOT_WORKSPACE_MEMBER' as const;
  constructor(userId: string, workspaceId: string) {
    super(
      `User ${userId} is not a member of workspace ${workspaceId}, so they cannot be added to a project in it.`,
    );
    this.name = 'TargetNotWorkspaceMemberError';
  }
}

export class AlreadyProjectMemberError extends Error {
  readonly code = 'ALREADY_PROJECT_MEMBER' as const;
  constructor(userId: string, projectId: string) {
    super(`User ${userId} is already a member of project ${projectId}.`);
    this.name = 'AlreadyProjectMemberError';
  }
}

export class NotAProjectMemberError extends Error {
  readonly code = 'NOT_A_PROJECT_MEMBER' as const;
  constructor(userId: string, projectId: string) {
    super(`User ${userId} is not a member of project ${projectId}.`);
    this.name = 'NotAProjectMemberError';
  }
}

export class PublicAccessUnavailableError extends Error {
  readonly code = 'PUBLIC_ACCESS_UNAVAILABLE' as const;
  constructor() {
    super(
      'Public projects are a Motir Cloud capability. This build does not serve a public ' +
        'reading surface, so a project cannot be made public on it.',
    );
    this.name = 'PublicAccessUnavailableError';
  }
}

export class InvalidAccessModeError extends Error {
  readonly code = 'INVALID_ACCESS_MODE' as const;
  constructor(mode: string) {
    super(`"${mode}" is not a valid project access mode (use workspace, members, or public).`);
    this.name = 'InvalidAccessModeError';
  }
}
