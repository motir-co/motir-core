import { ReleaseShapeRequiredError } from './errors';
import type { DeployReleaseInput, HostingDeployTarget, ReleaseShape } from './types';

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
