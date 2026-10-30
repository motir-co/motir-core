import { ProjectRepoNotFoundError } from '@/lib/projectRepos/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  ApplicationNotFoundError,
  CustomerRepositoryNotDeployableError,
  IllegalReleaseTransitionError,
  InvalidReleaseCursorError,
  NoPreviousReleaseError,
  ReleaseInProgressError,
  RollbackFailedError,
  RollbackNotPermittedError,
} from './errors';

// The ONE typed-error → HTTP mapping for the Production panel's routes (Story
// MOTIR-9797 · MOTIR-10036). No I/O. Each `code` is a stable contract the panel
// keys its message on — not a user string. Every body carries a FIXED message,
// never the error's own text: a provider's words never reach a browser.
//
// Not found covers an unknown repository, another project's, one the viewer
// cannot browse and a customer repository alike, so none is distinguishable.

export type ProductionRouteErrorCode =
  | 'repository_not_found'
  | 'rollback_not_permitted'
  | 'no_previous_release'
  | 'release_in_progress'
  | 'rollback_conflict'
  | 'rollback_failed'
  | 'invalid_cursor';

export interface ProductionRouteError {
  status: number;
  code: ProductionRouteErrorCode;
  message: string;
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
  if (err instanceof InvalidReleaseCursorError) {
    return { status: 400, code: 'invalid_cursor', message: 'Invalid cursor.' };
  }
  return null;
}

/** The response for a typed error, or null to rethrow. */
export function productionRouteErrorResponse(err: unknown): Response | null {
  const mapped = productionRouteError(err);
  if (!mapped) return null;
  return Response.json(
    { error: { code: mapped.code, message: mapped.message } },
    { status: mapped.status },
  );
}
