import { ReleaseArtifactUnsupportedError, ReleaseRuntimeRefusedError } from '../../hosting/errors';
import type { DeployReleaseInput } from '../../hosting/types';
import type { ServerlessHostingConfig } from './config';

// What the serverless target refuses BEFORE any provider call (MOTIR-9972).
// `deploy` calls this first, so a refused release costs nothing and changes
// nothing in the account.
//
// ⚠️ A PLACEHOLDER for the idle policy. `always_on` maps to provisioned
// concurrency on the `live` alias, which the next card (the serverless target's
// refusals and idle policy) builds together with the manifest-field refusals.
// Until then it fails closed: refused, never silently deployed as `suspend`.

/** The image URI Lambda pulls: the ref pinned by digest when one is given. */
export function imageUriOf(ref: string, digest: string | undefined): string {
  return digest ? `${ref}@${digest}` : ref;
}

/** Whether `ref` is an image in the serverless account's own ECR, in its region. */
function isOwnEcrImage(ref: string, config: ServerlessHostingConfig): boolean {
  const registry = `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com/`;
  return ref.startsWith(registry) && ref.length > registry.length;
}

export function assertServerlessRunnable(
  input: DeployReleaseInput,
  config: ServerlessHostingConfig,
): string {
  const { artifact } = input;
  if (artifact.kind !== 'image' || !isOwnEcrImage(artifact.ref, config)) {
    throw new ReleaseArtifactUnsupportedError(
      'serverless',
      artifact.kind === 'image' ? 'non-ECR image' : artifact.kind,
    );
  }
  if (input.idle.mode === 'always_on') {
    throw new ReleaseRuntimeRefusedError(
      'serverless',
      'idle',
      'always-on is not available on the serverless target yet',
    );
  }
  return imageUriOf(artifact.ref, artifact.digest);
}
