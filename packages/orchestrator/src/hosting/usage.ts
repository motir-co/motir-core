// Running time from a release's start/stop history (MOTIR-5773). Shared by every
// adapter and the fake, so "stopped and suspended time is not running time" has
// one implementation: an adapter turns its provider's events into transitions,
// and this sums the running intervals inside a window.

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
