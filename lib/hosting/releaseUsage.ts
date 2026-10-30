import type { HostingDeployTarget, ReleaseHandle } from '@motir/orchestrator';

// A production release's RUNNING TIME (Story MOTIR-9797 · MOTIR-10034): the pure
// half of settling it — where the next window starts, and the deploy port's
// handle rebuilt from the release row. No I/O.

/** The release columns a settle reads. */
export interface ReleaseUsageFacts {
  liveAt: Date | null;
  usageSettledUntil: Date | null;
  providerReleaseId: string | null;
  providerRef: string | null;
}

/** Where the next settle's window starts: the end of the last one, or the time
 *  the release went live the first time. Null for a release never live. */
export function usageWindowStart(release: ReleaseUsageFacts): Date | null {
  return release.usageSettledUntil ?? release.liveAt;
}

/**
 * The deploy port's handle for a production release, from its application's
 * target and app and the two ids the release service stored when the deploy
 * answered. Null when the release never got them (it never went live).
 */
export function releaseHandleFor(
  application: { target: HostingDeployTarget; appRef: string },
  release: ReleaseUsageFacts,
): ReleaseHandle | null {
  if (release.providerReleaseId === null || release.providerRef === null) return null;
  return {
    target: application.target,
    appRef: application.appRef,
    environment: { kind: 'production' },
    releaseId: release.providerReleaseId,
    providerRef: release.providerRef,
  };
}

/**
 * The window a port answer closes: its whole running seconds, and the instant
 * the next window starts. The end never moves back before `since` — a port
 * whose clock reads earlier settles nothing rather than reopening time already
 * counted.
 */
export function settledWindow(
  since: Date,
  usage: { runningSeconds: number; until: Date },
): { seconds: number; settledUntil: Date } {
  const seconds = Math.max(0, Math.floor(usage.runningSeconds));
  const settledUntil = usage.until.getTime() > since.getTime() ? usage.until : since;
  return { seconds, settledUntil };
}
