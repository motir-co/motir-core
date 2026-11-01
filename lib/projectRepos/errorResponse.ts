import { NextResponse } from 'next/server';
import {
  PermissionDeniedError,
  ProjectNotFoundError,
  ProjectAccessDeniedError,
} from '@/lib/projects/errors';
import {
  AiPlanRequiredError,
  AiPlanUnknownError,
  GithubIdentityRequiredError,
  ProjectRepoInvalidFieldError,
  ProjectRepoLinkConflictError,
  ProjectRepoNameTakenError,
  ProjectRepoNotFoundError,
  ProjectRepoNotTransferableError,
  ProjectRepoSeedRefusedError,
  ProjectRepoStateTransitionError,
  ProjectRepoTakeoverStateError,
  RealizedRepoAlreadyClaimedError,
  RepoTransferRefusedError,
} from '@/lib/projectRepos/errors';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';

/**
 * Shared typed-error → HTTP mapping for the repository-SET routes (Story
 * MOTIR-1775 · MOTIR-1782), the `mapLabelError` pattern. Returns null for errors
 * the route should rethrow — an unmapped error is a 500, and deliberately so.
 *
 * The mapping is the one each error class already documents on itself, kept in
 * ONE place so five route files cannot drift on what a name collision means:
 *
 *   ProjectNotFoundError / ProjectRepoNotFoundError → 404 (a missing row and
 *     another tenant's row are indistinguishable by construction — the
 *     no-existence-leak posture the set service inherits from the access gate)
 *   ProjectAccessDeniedError                        → 403 (a member who may
 *     browse the project but not edit it)
 *   ProjectRepoNameTakenError /
 *   RealizedRepoAlreadyClaimedError /
 *   ProjectRepoLinkConflictError /
 *   ProjectRepoStateTransitionError                 → 409 (a conflict with the
 *     set's current state — including the LOST RACE, which is why the transition
 *     error is here and not at 422: the caller's move was legal when they chose
 *     it and a concurrent editor moved first, so re-reading and retrying is the
 *     correct response — and `ProjectRepoLinkConflictError` is that same lost
 *     race when the database declined to say WHICH uniqueness it lost on
 *     (MOTIR-4833), which changes what we can tell the caller and not the status)
 *   ProjectRepoInvalidFieldError                    → 422 (a value the shape
 *     rules reject — a blank or over-long name, an illegal character)
 *   OrganizationNotFoundError → 404 · OrgForbiddenError → 403 (the ORG-tier gate
 *     on the add paths, MOTIR-4678 — see the note at the arm)
 *   AiPlanRequiredError → 402 · AiPlanUnknownError → 503 (the paid-AI-plan gate
 *     on establish, MOTIR-6909)
 *   ProjectRepoSeedRefusedError → 409 when the row's state moved on, else 422
 *     (a re-point to a seed the row may not start from, MOTIR-709); the body
 *     carries `refusal`, so a client can tell the rules apart
 */
export function mapProjectRepoError(err: unknown): NextResponse | null {
  if (err instanceof ProjectNotFoundError || err instanceof ProjectRepoNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  // MOTIR-2299 — the SET writes and the code-access grant ask
  // `repository:manage` / `repository:manage_access` through the shared gate, so
  // the refusal arrives as `PermissionDeniedError` carrying the key rather than
  // as `ProjectAccessDeniedError`. Same 403; the body gains `permission`.
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, permission: err.permission },
      { status: 403 },
    );
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (
    err instanceof ProjectRepoNameTakenError ||
    err instanceof RealizedRepoAlreadyClaimedError ||
    err instanceof ProjectRepoLinkConflictError ||
    err instanceof ProjectRepoStateTransitionError ||
    err instanceof ProjectRepoNotTransferableError ||
    err instanceof ProjectRepoTakeoverStateError ||
    err instanceof GithubIdentityRequiredError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof ProjectRepoSeedRefusedError) {
    return NextResponse.json(
      { code: err.code, refusal: err.refusal, error: err.message },
      { status: err.refusal === 'not_editable' ? 409 : 422 },
    );
  }
  if (err instanceof ProjectRepoInvalidFieldError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  // The ORG-tier gate on the add paths (MOTIR-4678). Its two arms keep the ORG
  // tier's own posture rather than being flattened into the project one: a
  // non-member of the organisation gets 404 (an org they are not in must be
  // indistinguishable from one that does not exist), a plain member gets 403
  // (they can already see it, so there is nothing left to hide).
  if (err instanceof OrganizationNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof OrgForbiddenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  // The takeover's upstream failure (MOTIR-711): GitHub refused, and no change to
  // the request would fix it — so it is a 502, not a 4xx blaming the caller. The
  // row is already `failed` with the reason recorded and is re-promptable.
  // The paid-AI-plan gate on establish (MOTIR-6909). No plan is 402 — the one
  // thing that changes the answer is paying; an unreadable plan is 503 — nothing
  // about the request is wrong, and a retry is the right response.
  if (err instanceof AiPlanRequiredError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 402 });
  }
  if (err instanceof AiPlanUnknownError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 503 });
  }
  if (err instanceof RepoTransferRefusedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
  }
  return null;
}
