import { HostingAppNameInvalidError } from '../../../hosting/errors';
import type {
  HostingEnvironment,
  OriginCredentialKind,
  ReleaseDescription,
  ReleaseShape,
} from '../../../hosting/types';
import { taskDefinitionRevision } from './container/names';
import type { ContainerReleaseDescription } from './container';
import type { FunctionReleaseDescription } from './function';

// The AWS adapter's RELEASE IDS and record mapping (MOTIR-10010). The shape
// modules speak in their provider's terms — a Lambda version, a task definition
// revision's ARN — and the port speaks in release ids; this is the one place
// the two meet.
//
// A release id is `<appRef>:<n>`, where `n` is the release's number in its
// environment: the function's published version, or the container's task
// definition revision. Both are numbered by AWS from 1 in a new account and
// never reused, so the id is fixed by the environment and the deploys before it
// — a repeated deploy (a no change) answers the same id, and a deploy held for
// its tenant account names release 1, which is what the account's first publish
// makes.

/** The app-name prefix every AWS release carries (MOTIR-5769 §4). */
export const AWS_APP_PREFIX = 'mh-';

/** The number a release held for its tenant account will have. */
export const FIRST_RELEASE_NUMBER = 1;

const APP_REF = /^mh-([a-z0-9]+)(?:-pr([1-9][0-9]*))?$/;

/** The repository and environment an `appRef` names. */
export interface ParsedAppRef {
  readonly repositoryId: string;
  readonly environment: HostingEnvironment;
}

/** `mh-<rid>` or `mh-<rid>-pr<n>` back into its repository and environment. */
export function parseAwsAppRef(appRef: string): ParsedAppRef {
  const match = APP_REF.exec(appRef);
  if (!match) throw new HostingAppNameInvalidError(appRef);
  const environment: HostingEnvironment = match[2]
    ? { kind: 'preview', pullRequest: Number(match[2]) }
    : { kind: 'production' };
  return { repositoryId: match[1]!, environment };
}

/** The release id of release `n` of an app. */
export function awsReleaseId(appRef: string, n: number): string {
  return `${appRef}:${n}`;
}

/** A shape module's release reference (a Lambda version, or a task definition
 *  ARN) as the release's number. */
export function releaseNumberOf(shape: ReleaseShape, providerRelease: string): number {
  return shape === 'function' ? Number(providerRelease) : taskDefinitionRevision(providerRelease);
}

/** A shape module's release reference as the port's release id. */
export function portReleaseId(
  shape: ReleaseShape,
  appRef: string,
  providerRelease: string | null,
): string | null {
  return providerRelease === null
    ? null
    : awsReleaseId(appRef, releaseNumberOf(shape, providerRelease));
}

/** A handle's `providerRef`: the shape and the release stack, so a describe or
 *  destroy routes without reading the stack first. */
export function awsProviderRef(shape: ReleaseShape, stackName: string): string {
  return `${shape}:${stackName}`;
}

/** The shape a `providerRef` carries, or null when it is not one of ours. */
export function shapeOfProviderRef(providerRef: string): ReleaseShape | null {
  const shape = providerRef.slice(0, providerRef.indexOf(':'));
  return shape === 'function' || shape === 'container' ? shape : null;
}

/** The shape a release stack was applied as, from its parameters: only the
 *  function template takes the forwarder's principal, only the container's a
 *  task size. Null for a stack that is neither. */
export function shapeOfReleaseStack(
  parameters: Readonly<Record<string, string>>,
): ReleaseShape | null {
  if ('InvokePrincipalArn' in parameters) return 'function';
  if ('TaskCpu' in parameters) return 'container';
  return null;
}

/** What a forwarder sends to a release of that shape (MOTIR-5769 §4). */
export function originCredentialOf(shape: ReleaseShape): OriginCredentialKind {
  return shape === 'function' ? 'aws_sigv4' : 'origin_secret';
}

/** A shape module's description as the port's. */
export function toReleaseDescription(
  shape: ReleaseShape,
  appRef: string,
  description: FunctionReleaseDescription | ContainerReleaseDescription,
): ReleaseDescription {
  return {
    state: description.state,
    releaseId: portReleaseId(shape, appRef, description.releaseId),
    previousReleaseId: portReleaseId(shape, appRef, description.previousReleaseId),
    upstreamAddress: description.upstreamAddress,
    originCredential: description.originCredential,
  };
}
