// Usage on the serverless target (MOTIR-9972): METERED COMPUTE, not a running
// history. Lambda keeps no record of a release starting and stopping — it runs
// only while it answers — so `runningSeconds` is the sum of CloudWatch's
// `AWS/Lambda` `Duration` over the window, and `invocations` its `Invocations`.
// CloudWatch lags a few minutes, so a read right after the last request can
// under-count the final window; the contract is that usage is read from the
// provider, not that it is exact to the second.

export interface LambdaMetricSums {
  readonly durationMs: number;
  readonly invocations: number;
}

const DAY_MS = 86_400_000;

/**
 * The period of a one-bucket metric query over `[since, until]`. CloudWatch keeps
 * one-minute points for 15 days, five-minute ones for 63 and hourly ones after,
 * and refuses a period finer than what it still holds at the window's start.
 */
export function metricPeriodSeconds(since: Date, until: Date, now: Date): number {
  const age = now.getTime() - since.getTime();
  const step = age > 63 * DAY_MS ? 3600 : age > 15 * DAY_MS ? 300 : 60;
  const window = Math.max(1, Math.ceil((until.getTime() - since.getTime()) / 1000));
  return Math.ceil(window / step) * step;
}

/** Summed duration as whole seconds. */
export function computeSecondsOf(sums: LambdaMetricSums): number {
  return Math.round(sums.durationMs / 1000);
}
