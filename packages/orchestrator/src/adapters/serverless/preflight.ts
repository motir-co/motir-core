import { ReleaseArtifactUnsupportedError, ReleaseRuntimeRefusedError } from '../../hosting/errors';
import type { DeployReleaseInput } from '../../hosting/types';
import type { ServerlessHostingConfig } from './config';
import { parseStartCommand } from './startCommand';

// What the serverless target refuses BEFORE any provider call (MOTIR-9972 ·
// MOTIR-9974). `deploy` calls this first, so a refused release costs nothing
// and changes nothing in the account.
//
// The target is HTTP-only (decision D3, MOTIR-5769): a release that declares
// background work or websockets, or whose start command is not one foreground
// command Lambda can run with no shell, is refused by the MANIFEST's own field
// name, pointing to the Fly target. The order is fixed: the artifact, then
// `requires` absent, `requires.backgroundWork`, `requires.websockets`,
// `startCommand`. A missing `requires` is refused rather than assumed false —
// the adapter never runs a release it could not check.
//
// The idle policy is not a refusal: `always_on` is provisioned concurrency on
// the `live` alias, applied by `deploy` (`./idle`).

/** Where every refusal sends the operator. */
const GO_TO_FLY =
  'the serverless target is HTTP-only — declare the fly target in motir.hosting.json';

/** The image URI Lambda pulls: the ref pinned by digest when one is given. */
export function imageUriOf(ref: string, digest: string | undefined): string {
  return digest ? `${ref}@${digest}` : ref;
}

/** Whether `ref` is an image in the serverless account's own ECR, in its region. */
function isOwnEcrImage(ref: string, config: ServerlessHostingConfig): boolean {
  const registry = `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com/`;
  return ref.startsWith(registry) && ref.length > registry.length;
}

function refuse(field: string, reason: string): never {
  throw new ReleaseRuntimeRefusedError('serverless', field, `${reason}; ${GO_TO_FLY}`);
}

/** What `deploy` runs: the image by digest and its command as argv. */
export interface ServerlessRunnable {
  readonly imageUri: string;
  readonly command: string[];
}

export function assertServerlessRunnable(
  input: DeployReleaseInput,
  config: ServerlessHostingConfig,
): ServerlessRunnable {
  const { artifact, runtime } = input;
  if (artifact.kind !== 'image' || !isOwnEcrImage(artifact.ref, config)) {
    throw new ReleaseArtifactUnsupportedError(
      'serverless',
      artifact.kind === 'image' ? 'non-ECR image' : artifact.kind,
    );
  }
  const { requires } = runtime;
  if (!requires) refuse('requires', 'the release does not say what it requires');
  if (requires.backgroundWork) {
    refuse('requires.backgroundWork', 'background work needs a process that keeps running');
  }
  if (requires.websockets) refuse('requires.websockets', 'websockets need a held connection');
  const start = parseStartCommand(runtime.startCommand);
  if ('refused' in start) refuse('startCommand', start.refused);
  return { imageUri: imageUriOf(artifact.ref, artifact.digest), command: start.argv };
}
