import { ProjectRepoNotFoundError } from '@/lib/projectRepos/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  AlwaysOnRefusedOutOfCreditsError,
  ApplicationNotFoundError,
  CustomerRepositoryNotDeployableError,
  IdlePolicyApplyFailedError,
  IdlePolicyNotPermittedError,
  IdlePolicyUnsupportedForTargetError,
  IllegalReleaseTransitionError,
  InvalidIdlePolicyError,
  InvalidLogCursorError,
  InvalidLogLimitError,
  InvalidLogRangeError,
  InvalidReleaseCursorError,
  NoPreviousReleaseError,
  NoProductionApplicationError,
  ReleaseInProgressError,
  RepositoryTakenOverError,
  RollbackFailedError,
  RollbackNotPermittedError,
} from './errors';

// The ONE typed-error → HTTP mapping for the Production panel's routes (Story
// MOTIR-9797 · MOTIR-10036). No I/O. Each `code` is a stable contract the panel
// keys its message on — not a user string. Every body carries a FIXED message,
// never the error's own text: a provider's words never reach a browser.
//
// Not found covers an unknown repository, another project's, one the viewer
// cannot browse and a customer repository alike, so none is distinguishable. A
// TAKEN-OVER repository is not folded into it: it is the organisation's own and
// the panel shows it, so it answers its own 409 (MOTIR-12127).

export type ProductionRouteErrorCode =
  | 'repository_not_found'
  | 'rollback_not_permitted'
  | 'no_previous_release'
  | 'release_in_progress'
  | 'repository_taken_over'
  | 'rollback_conflict'
  | 'rollback_failed'
  | 'invalid_cursor'
  | 'invalid_idle_policy'
  | 'idle_policy_not_permitted'
  | 'HOSTING_IDLE_POLICY_UNSUPPORTED'
  | 'no_application'
  | 'idle_policy_failed'
  | 'always_on_refused_out_of_credits'
  | 'invalid_log_range'
  | 'invalid_limit';

export interface ProductionRouteError {
  status: number;
  code: ProductionRouteErrorCode;
  message: string;
  /** What the panel's copy names — only the idle-policy refusal carries it. */
  details?: { target: string; shape: string | null; mode: string };
}

const NOT_FOUND: ProductionRouteError = {
  status: 404,
  code: 'repository_not_found',
  message: 'Repository not found.',
};

/** The status and stable code for a typed error, or null for one it does not
 *  know — which the route rethrows, so an unmapped error is a 500. */
export function productionRouteError(err: unknown): ProductionRouteError | null {
  if (
    err instanceof ProjectNotFoundError ||
    err instanceof ProjectRepoNotFoundError ||
    err instanceof CustomerRepositoryNotDeployableError ||
    err instanceof ApplicationNotFoundError
  ) {
    return NOT_FOUND;
  }
  if (err instanceof RepositoryTakenOverError) {
    return {
      status: 409,
      code: 'repository_taken_over',
      message: 'This repository has been taken over and is no longer deployed by Motir.',
    };
  }
  if (err instanceof RollbackNotPermittedError) {
    return {
      status: 403,
      code: 'rollback_not_permitted',
      message: 'Rolling back production needs the project administration permission.',
    };
  }
  if (err instanceof NoPreviousReleaseError) {
    return { status: 409, code: 'no_previous_release', message: 'There is no previous release.' };
  }
  if (err instanceof ReleaseInProgressError) {
    return { status: 409, code: 'release_in_progress', message: 'A release is in progress.' };
  }
  if (err instanceof IllegalReleaseTransitionError) {
    return {
      status: 409,
      code: 'rollback_conflict',
      message: 'Production changed while rolling back.',
    };
  }
  if (err instanceof RollbackFailedError) {
    return { status: 502, code: 'rollback_failed', message: 'The rollback did not complete.' };
  }
  if (err instanceof InvalidReleaseCursorError || err instanceof InvalidLogCursorError) {
    return { status: 400, code: 'invalid_cursor', message: 'Invalid cursor.' };
  }
  // The idle policy (MOTIR-12107).
  if (err instanceof InvalidIdlePolicyError) {
    return { status: 400, code: 'invalid_idle_policy', message: 'Invalid idle policy.' };
  }
  if (err instanceof IdlePolicyNotPermittedError) {
    return {
      status: 403,
      code: 'idle_policy_not_permitted',
      message: 'Changing the idle policy needs the project administration permission.',
    };
  }
  if (err instanceof IdlePolicyUnsupportedForTargetError) {
    return {
      status: 409,
      code: 'HOSTING_IDLE_POLICY_UNSUPPORTED',
      message: 'This hosting target and shape cannot run that idle policy.',
      details: { target: err.target, shape: err.shape, mode: err.mode },
    };
  }
  if (err instanceof NoProductionApplicationError) {
    return { status: 409, code: 'no_application', message: 'Nothing is in production yet.' };
  }
  if (err instanceof IdlePolicyApplyFailedError) {
    return {
      status: 502,
      code: 'idle_policy_failed',
      message: 'The idle policy could not be applied.',
    };
  }
  // Decision MOTIR-12100 §9 (MOTIR-12108).
  if (err instanceof AlwaysOnRefusedOutOfCreditsError) {
    return {
      status: 409,
      code: 'always_on_refused_out_of_credits',
      message: 'Always on is not available while the organisation is out of credits.',
    };
  }
  // The logs read (MOTIR-12105).
  if (err instanceof InvalidLogRangeError) {
    return {
      status: 400,
      code: 'invalid_log_range',
      message: '`since` and `until` must be ISO 8601 instants, `until` not before `since`.',
    };
  }
  if (err instanceof InvalidLogLimitError) {
    return {
      status: 400,
      code: 'invalid_limit',
      message: '`limit` must be a whole number from 1.',
    };
  }
  return null;
}

/** The response for a typed error, or null to rethrow. */
export function productionRouteErrorResponse(err: unknown): Response | null {
  const mapped = productionRouteError(err);
  if (!mapped) return null;
  return Response.json(
    {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details ? { details: mapped.details } : {}),
      },
    },
    { status: mapped.status },
  );
}
