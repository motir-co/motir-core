// Running time from a release's start/stop history (MOTIR-5773). Shared by every
// adapter and the fake, so "stopped and suspended time is not running time" has
// one implementation: an adapter turns its provider's events into transitions,
// and this sums the running intervals inside a window.

import type { HostingEnvironment, ReleaseComputeUsage, ReleaseShape, ReleaseSize } from './types';

/** One change of a release's running state, at an instant. */
export interface RunTransition {
  readonly at: Date;
  readonly running: boolean;
}

/**
 * Whole seconds a release ran within `[since, until]`.
 *
 * The state at `since` is the last transition at or before it. When the history
 * starts inside the window (a provider keeps only its recent events), the state
 * before the first transition is taken as the opposite of it: a history that
 * opens with a stop was running until then.
 */
export function runningSecondsBetween(
  transitions: readonly RunTransition[],
  since: Date,
  until: Date,
): number {
  const ordered = [...transitions].sort((a, b) => a.at.getTime() - b.at.getTime());
  const start = since.getTime();
  const end = until.getTime();
  if (end <= start) return 0;
  const before = ordered.filter((t) => t.at.getTime() <= start);
  let running =
    before.length > 0 ? before[before.length - 1]!.running : !(ordered[0]?.running ?? true);
  let cursor = start;
  let totalMs = 0;
  for (const t of ordered) {
    const at = t.at.getTime();
    if (at <= start) continue;
    if (at >= end) break;
    if (running) totalMs += at - cursor;
    cursor = at;
    running = t.running;
  }
  if (running) totalMs += end - cursor;
  return Math.floor(totalMs / 1000);
}

// ── The AWS SIZE TABLE (MOTIR-5769 §4, MOTIR-10002) ─────────────────────────
//
// ONE table, read by the fake and by the real function and container shapes, so
// the compute units a release reports are derived from the same numbers it was
// sized with. A function is 1,769 MB (one vCPU on x86_64) whatever its size or
// environment. A container preview runs at 0.25 vCPU / 0.5 GB whatever its input
// says; a production container is sized by the repository row's size.

/** A Lambda function's memory, in MB, for every release. */
export const AWS_FUNCTION_MEMORY_MB = 1769;

/** A Fargate task's vCPU and memory (GB). */
export interface FargateSize {
  readonly vcpu: number;
  readonly memoryGb: number;
}

/** A preview container, whatever size its input names. */
export const AWS_CONTAINER_PREVIEW_SIZE: FargateSize = { vcpu: 0.25, memoryGb: 0.5 };

/** A production container, by the row's size. */
export const AWS_CONTAINER_PRODUCTION_SIZES: Readonly<Record<ReleaseSize, FargateSize>> = {
  small: { vcpu: 0.25, memoryGb: 0.5 },
  medium: { vcpu: 0.5, memoryGb: 1 },
  large: { vcpu: 1, memoryGb: 2 },
};

/** The Fargate size a container release runs at. Absent size means `small`. */
export function awsContainerSize(
  size: ReleaseSize | undefined,
  environment: HostingEnvironment,
): FargateSize {
  if (environment.kind === 'preview') return AWS_CONTAINER_PREVIEW_SIZE;
  return AWS_CONTAINER_PRODUCTION_SIZES[size ?? 'small'];
}

/** The compute units `runningSeconds` of a release of that shape amount to. */
export function computeUsageFor(
  shape: ReleaseShape,
  size: ReleaseSize | undefined,
  environment: HostingEnvironment,
  runningSeconds: number,
): ReleaseComputeUsage {
  if (shape === 'function') {
    return { unit: 'lambda', gbSeconds: (runningSeconds * AWS_FUNCTION_MEMORY_MB) / 1024 };
  }
  const { vcpu, memoryGb } = awsContainerSize(size, environment);
  return {
    unit: 'fargate',
    vcpuSeconds: runningSeconds * vcpu,
    gbSeconds: runningSeconds * memoryGb,
  };
}
