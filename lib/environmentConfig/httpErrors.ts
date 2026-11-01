import { NextResponse } from 'next/server';
import { ProjectRepoNotFoundError } from '@/lib/projectRepos/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CustomerRepositoryError,
  EnvironmentConfigForbiddenError,
  EnvironmentEntryNotFoundError,
  InvalidEnvironmentNameError,
  ReservedEnvironmentNameError,
} from './errors';

// The ONE typed-error → HTTP mapping for the environment-configuration routes
// (Story MOTIR-9795 · MOTIR-9964). Every body is `{ error: { code, message, name? } }`;
// each message names an entry or a repository and never a value, because the
// errors themselves are built that way. Returns null for an error it does not
// know, which the route rethrows — an unmapped error is a 500, never a success.
//
// A customer repository answers 404: it has no Environment section, so to the
// caller it is not there. A repository of another workspace is the same 404.

export interface EnvironmentConfigErrorMapping {
  status: number;
  code: string;
  name?: string;
}

export function mapEnvironmentConfigError(err: unknown): EnvironmentConfigErrorMapping | null {
  if (err instanceof ReservedEnvironmentNameError) {
    return { status: 422, code: 'reserved_environment_name', name: err.reservedName };
  }
  if (err instanceof InvalidEnvironmentNameError) {
    return { status: 422, code: 'invalid_environment_name', name: err.entryName };
  }
  if (err instanceof EnvironmentEntryNotFoundError) {
    return { status: 404, code: 'environment_entry_not_found', name: err.entryName };
  }
  if (err instanceof EnvironmentConfigForbiddenError || err instanceof ProjectAccessDeniedError) {
    return { status: 403, code: 'environment_config_forbidden' };
  }
  if (
    err instanceof CustomerRepositoryError ||
    err instanceof ProjectRepoNotFoundError ||
    err instanceof ProjectNotFoundError
  ) {
    return { status: 404, code: 'repository_not_found' };
  }
  return null;
}

export function environmentConfigErrorResponse(
  status: number,
  code: string,
  message: string,
  name?: string,
): Response {
  return NextResponse.json(
    { error: { code, message, ...(name === undefined ? {} : { name }) } },
    { status },
  );
}

/** The response for a typed error, or null to rethrow. */
export function environmentConfigErrorFor(err: unknown): Response | null {
  const mapped = mapEnvironmentConfigError(err);
  if (!mapped) return null;
  // A not-found answers the same message for an unknown repository, another
  // workspace's and a customer repository, so none of them is distinguishable.
  const message =
    mapped.code === 'repository_not_found' ? 'Repository not found.' : (err as Error).message;
  return environmentConfigErrorResponse(mapped.status, mapped.code, message, mapped.name);
}

export const environmentNotFoundResponse = (): Response =>
  environmentConfigErrorResponse(404, 'environment_not_found', 'Unknown environment.');
