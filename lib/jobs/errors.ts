// Typed errors for the operator-dashboard surface of the background-jobs
// runtime (Story 1.6 · Subtask 1.6.5). The Server Action layer translates
// these into UI results (toast copy); they keep the service from leaking raw
// Error strings to the transport.

/**
 * Thrown when a non-owner attempts to replay a dead-lettered job. Replay is
 * gated to the workspace `owner` role (lib/workspaces/roles.ts); members get a
 * disabled button in the UI, but the service re-checks server-side so the gate
 * can't be bypassed by posting the action directly.
 */
export class ReplayForbiddenError extends Error {
  readonly code = 'REPLAY_FORBIDDEN' as const;
  constructor(userId: string, workspaceId: string) {
    super(`User ${userId} is not an owner of workspace ${workspaceId} and cannot replay jobs`);
    this.name = 'ReplayForbiddenError';
  }
}

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
 * Thrown when the operator's system replay is pointed at a dead letter that
 * BELONGS to a workspace (MOTIR-8083). That row keeps its own door, the
 * manager-gated replay on the workspace's Dead letter tab; the system door runs
 * under `withSystemContext`, which bypasses tenant RLS, so it takes only rows
 * with `workspace_id IS NULL` and refuses the rest by name.
 */
export class SystemReplayWorkspaceRowError extends Error {
  readonly code = 'SYSTEM_REPLAY_WORKSPACE_ROW' as const;
  constructor(dlqId: string) {
    super(`job_run_dlq ${dlqId} belongs to a workspace and cannot be replayed as a system row`);
    this.name = 'SystemReplayWorkspaceRowError';
  }
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
