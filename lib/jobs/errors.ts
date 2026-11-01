// Typed errors for the platform job ledger at /admin/jobs (Story 1.6 · Subtask
// 1.6.5, the tenant dashboard's doors retired by Story MOTIR-9982). The Server
// Action layer translates these into UI results (toast copy); they keep the
// service from leaking raw Error strings to the transport.

/**
 * Thrown when a replay targets a DLQ id that isn't in the caller's workspace
 * (unknown id, or another workspace's row hidden by RLS). Surfaces as a
 * not-found to the UI — never confirms a cross-workspace id exists.
 */
export class DlqEntryNotFoundError extends Error {
  readonly code = 'DLQ_NOT_FOUND' as const;
  constructor(dlqId: string) {
    super(`job_run_dlq ${dlqId} not found in the active workspace`);
    this.name = 'DlqEntryNotFoundError';
  }
}

/**
 * Thrown when someone below the `operator` platform role (`User.platformRole`,
 * MOTIR-8197) asks to replay a dead letter that has no workspace (MOTIR-8083). The System
 * tab hides the control from everyone else, and the service re-checks, so a
 * posted action cannot reach a system row from a tenant session.
 */
export class SystemReplayForbiddenError extends Error {
  readonly code = 'SYSTEM_REPLAY_FORBIDDEN' as const;
  constructor(userId: string) {
    super(`User ${userId} is not the platform operator and cannot replay system dead letters`);
    this.name = 'SystemReplayForbiddenError';
  }
}

/**
 * True for {@link SystemReplayForbiddenError}. The `(admin)` console's actions
 * test for the refusal through this guard rather than the class, because no
 * executable text under `app/(admin)` may spell the word the console's 404
 * posture forbids (`tests/platform/adminRouteGate.test.ts`).
 */
export function isSystemReplayRefusal(err: unknown): err is SystemReplayForbiddenError {
  return err instanceof SystemReplayForbiddenError;
}

/**
 * Thrown when someone below the `support` platform role reads the platform job
 * ledger (MOTIR-9984). Those reads run under `withSystemContext`, which bypasses
 * tenant RLS, so the role check in the service is the whole gate; the page's own
 * 404 is a second line, not the first.
 */
export class PlatformJobsReadForbiddenError extends Error {
  readonly code = 'PLATFORM_JOBS_READ_FORBIDDEN' as const;
  constructor() {
    super('The platform job ledger is read by platform staff at support or above');
    this.name = 'PlatformJobsReadForbiddenError';
  }
}
