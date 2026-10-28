import type { HostingEnvironment, ReleaseComputeUsage } from '../../../../hosting/types';
import { computeUsageFor } from '../../../../hosting/usage';

// A function release's COMPUTE (MOTIR-10008): Lambda bills the duration of each
// invocation times the memory, so GB-seconds are the `Duration` metric's sum in
// seconds times the size table's 1,769 MB in GB — `computeUsageFor` applies the
// memory, so it is never declared here. Not the invocation count: duration is
// what is billed.

/** The metric whose sum is a function's billed time, in milliseconds. */
export const FUNCTION_DURATION_METRIC = {
  namespace: 'AWS/Lambda',
  metricName: 'Duration',
} as const;

/** The compute a `Duration` sum of `durationMs` amounts to. */
export function functionComputeUsage(
  environment: HostingEnvironment,
  durationMs: number,
): ReleaseComputeUsage {
  return computeUsageFor('function', undefined, environment, durationMs / 1000);
}
