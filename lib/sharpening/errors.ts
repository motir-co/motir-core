// Typed refusals of the Sharpen write-back door (Task MOTIR-1101 · Subtask
// MOTIR-8175). Kept in their own file so the route can import them without the
// Prisma client (the lib/<domain>/errors.ts convention). The service throws
// these; `app/api/internal/ai/plan-sharpening/route.ts` maps each `code` to a
// status.

/** The plan has been decided (approved, declined) — it is no longer editable,
 *  so nothing is written to it. → 409 */
export class SharpeningPlanClosedError extends Error {
  readonly code = 'SHARPENING_PLAN_CLOSED' as const;
  constructor(
    readonly planId: string,
    readonly status: string,
  ) {
    super(`Plan ${planId} is ${status}; a sharpened requirement can no longer be written to it.`);
    this.name = 'SharpeningPlanClosedError';
  }
}

/** The write-back names something the door cannot write: a `perItem` proposal
 *  that is not an `add` of this plan. → 422 */
export class SharpeningInputInvalidError extends Error {
  readonly code = 'SHARPENING_INPUT_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SharpeningInputInvalidError';
  }
}

// ── The Sharpen session door (Subtask MOTIR-8181) ────────────────────────────

/** The plan or work item does not resolve in the active project, or the caller
 *  may not see it — indistinguishable from a target that never existed. → 404 */
export class SharpenTargetNotAvailableError extends Error {
  readonly code = 'SHARPEN_TARGET_NOT_AVAILABLE' as const;
  constructor() {
    super('That plan or work item is not available to sharpen.');
    this.name = 'SharpenTargetNotAvailableError';
  }
}

/** The target cannot be sharpened now: a plan that is generating, approved or
 *  declined; a work item that is done, cancelled or archived. → 409 */
export class SharpenTargetClosedError extends Error {
  readonly code = 'SHARPEN_TARGET_CLOSED' as const;
  constructor(
    readonly target: string,
    readonly state: string,
  ) {
    super(`${target} is ${state}; it cannot be sharpened.`);
    this.name = 'SharpenTargetClosedError';
  }
}

/** The session does not exist in this project, or is another person's. → 404 */
export class SharpenSessionNotFoundError extends Error {
  readonly code = 'SHARPEN_SESSION_NOT_FOUND' as const;
  constructor(sessionId: string) {
    super(`Sharpen session ${sessionId} was not found.`);
    this.name = 'SharpenSessionNotFoundError';
  }
}

/** The turn is not a person turn of this session. → 404 */
export class SharpenTurnNotFoundError extends Error {
  readonly code = 'SHARPEN_TURN_NOT_FOUND' as const;
  constructor(turnId: string) {
    super(`Sharpen turn ${turnId} was not found on this session.`);
    this.name = 'SharpenTurnNotFoundError';
  }
}

/** The session has ended; nothing more can be sent on it. → 409 */
export class SharpenSessionEndedError extends Error {
  readonly code = 'SHARPEN_SESSION_ENDED' as const;
  constructor(sessionId: string) {
    super(`Sharpen session ${sessionId} has ended.`);
    this.name = 'SharpenSessionEndedError';
  }
}

/** A turn is still waiting on the planner (or on a resubmit); only Stop may be
 *  sent until it settles. → 409 */
export class SharpenTurnInFlightError extends Error {
  readonly code = 'SHARPEN_TURN_IN_FLIGHT' as const;
  constructor(readonly turnId: string) {
    super('The planner is still answering the last turn.');
    this.name = 'SharpenTurnInFlightError';
  }
}

/** The action does not fit the pending question. → 400 */
export class SharpenActionInvalidError extends Error {
  readonly code = 'SHARPEN_ACTION_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SharpenActionInvalidError';
  }
}
