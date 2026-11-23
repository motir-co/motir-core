import { IdlePolicyUnsupportedError, ReleaseShapeRequiredError } from './errors';
import type {
  DeployReleaseInput,
  HostingDeployTarget,
  ReleaseIdlePolicy,
  ReleaseShape,
} from './types';

// The release SHAPE gate (MOTIR-10002). A target with shapes (AWS) calls this
// first in `deploy`, before any other work, so a release with no shape is
// refused by name and nothing is created. The shape is an input — the
// repository's recorded hosting decision — and is never inferred from the
// artifact or the code (R2).

/** The release's shape, or `ReleaseShapeRequiredError` naming the target. */
export function requireReleaseShape(
  target: HostingDeployTarget,
  input: Pick<DeployReleaseInput, 'shape'>,
): ReleaseShape {
  if (input.shape === 'function' || input.shape === 'container') return input.shape;
  throw new ReleaseShapeRequiredError(target);
}

// The IDLE POLICY rule (MOTIR-12107): which target and shape can honour which
// policy. It is stated ONCE, here, and every adapter that refuses a policy calls
// it, so a caller that must decide before there is a release to deploy (storing
// an application's policy) reads the same rule the port enforces at deploy
// rather than re-declaring it. Today one pair refuses: an AWS container runs
// `always_on` only (MOTIR-5769 §4). Serverless always-on is provisioned
// concurrency and Fly maps suspend to auto-stop, so neither refuses.

/** The refusal for running `idle` on that target and shape, or null when the
 *  pair can honour it. */
export function idlePolicyRefusal(
  target: HostingDeployTarget,
  shape: ReleaseShape | null | undefined,
  idle: ReleaseIdlePolicy,
): IdlePolicyUnsupportedError | null {
  if (target === 'aws' && shape === 'container' && idle.mode !== 'always_on') {
    return new IdlePolicyUnsupportedError(target, shape, idle.mode);
  }
  return null;
}

/** Throws {@link IdlePolicyUnsupportedError} when the pair cannot honour `idle`. */
export function assertIdlePolicySupported(
  target: HostingDeployTarget,
  shape: ReleaseShape | null | undefined,
  idle: ReleaseIdlePolicy,
): void {
  const refusal = idlePolicyRefusal(target, shape, idle);
  if (refusal) throw refusal;
}
