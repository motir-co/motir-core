// Typed errors for the plan-change conversation (Story 7.30 · MOTIR-1728). Kept
// in their own file so route handlers can import them without pulling in the
// Prisma client (the lib/<domain>/errors.ts convention). The service throws
// these; the route layer translates the stable `code` to an HTTP status.

/** The project has no plan-change conversation yet (a read/append/submit against
 *  a thread that was never opened). → 404 */
export class PlanChangeSessionNotFoundError extends Error {
  readonly code = 'PLAN_CHANGE_SESSION_NOT_FOUND' as const;
  constructor(projectId: string) {
    super(`No plan-change conversation exists for project ${projectId}.`);
    this.name = 'PlanChangeSessionNotFoundError';
  }
}

/**
 * A session addressed BY ID does not exist in this project (AMENDMENT 17 §2 —
 * every door addresses a session by its id). Distinct from
 * {@link PlanChangeSessionNotFoundError}, which answers a SCOPE that has no
 * conversation: an id from another project, another tenant or a deleted session
 * is refused here, never resolved to a sibling session of the same scope.
 */
export class PlanSessionNotFoundError extends Error {
  readonly code = 'PLAN_SESSION_NOT_FOUND' as const;
  constructor(sessionId: string) {
    super(`No planning session ${sessionId} exists in this project.`);
    this.name = 'PlanSessionNotFoundError';
  }
}

/**
 * A person's turn on a session that has ENDED (AMENDMENT 23 §3; MOTIR-7639). An
 * ended session is never resumed: its cards are already given back, so a turn
 * there would talk to a conversation that can no longer plan anything. → 409, a
 * state conflict — the session exists, it is finished. Opening it is a read.
 */
export class PlanSessionEndedError extends Error {
  readonly code = 'PLAN_SESSION_ENDED' as const;
  constructor(readonly sessionId: string) {
    super(`Planning session ${sessionId} has ended, so it can't be continued.`);
    this.name = 'PlanSessionEndedError';
  }
}

/**
 * A copy asked of a session that cannot be copied (AMENDMENT 23 §6; MOTIR-7641):
 * it is still open, or it ended `restarted` (the person asked for something new)
 * or `approved` / `declined` (those were decisions). → 409, a state conflict.
 * A session that is not the caller's is a 404 instead, so nothing is confirmed.
 */
export class PlanSessionNotCopyableError extends Error {
  readonly code = 'PLAN_SESSION_NOT_COPYABLE' as const;
  constructor(
    readonly sessionId: string,
    readonly endReason: string | null,
  ) {
    super(
      endReason
        ? `Planning session ${sessionId} ended ${endReason}, so its conversation can't be carried into a new one.`
        : `Planning session ${sessionId} is still open, so there is nothing to carry over.`,
    );
    this.name = 'PlanSessionNotCopyableError';
  }
}

/**
 * The plan a carry was asked to move was DECIDED (approved or declined) between
 * the person reading it and sending their turn (Story MOTIR-7928 · MOTIR-7930).
 * Read under the plan's row lock, so the decision that won is always seen.
 * Nothing was created, copied, moved or appended. → 409
 */
export class PlanSessionPlanDecidedError extends Error {
  readonly code = 'PLAN_SESSION_PLAN_DECIDED' as const;
  constructor(
    readonly sessionId: string,
    readonly planId: string,
    readonly planStatus: string | null,
  ) {
    super(
      `The plan waiting in planning session ${sessionId} has been decided, so there is nothing left to carry or plan again.`,
    );
    this.name = 'PlanSessionPlanDecidedError';
  }
}

/** One finished card a stale plan names (MOTIR-7945). */
export interface StalePlanFinishedCard {
  id: string;
  key: string;
  title: string;
  status: string;
  statusLabel: string;
}

/**
 * A turn on a conversation whose waiting plan is STALE (MOTIR-7945): work it
 * changes has finished, so the plan cannot be approved and is not revised.
 * Nothing was submitted and nothing was spent; the overlay words this outcome,
 * naming `finishedCards`, and offers Plan it again (`planAgainOf`). → 409
 */
export class PlanSessionPlanStaleError extends Error {
  readonly code = 'PLAN_SESSION_PLAN_STALE' as const;
  constructor(
    readonly planId: string,
    readonly finishedCards: StalePlanFinishedCard[],
  ) {
    super(
      `Plan ${planId} is stale: work it changes has finished, so it cannot be revised. ` +
        'Send the turn again with `planAgainOf` to plan it again in this conversation.',
    );
    this.name = 'PlanSessionPlanStaleError';
  }
}

/**
 * Plan it again was accepted for a stale plan that is no longer the one the
 * conversation waits on (`superseded`: a newer plan exists), or a second accept
 * lost to the first (`superseded`, `latestPlanId` null while the winner's job
 * is in flight). Nothing was submitted. → 409
 */
export class PlanAgainNotAvailableError extends Error {
  readonly code = 'PLAN_SESSION_PLAN_AGAIN_NOT_AVAILABLE' as const;
  constructor(
    readonly reason: 'superseded',
    readonly latestPlanId: string | null,
  ) {
    super('This plan has already been planned again; the conversation is on a newer plan.');
    this.name = 'PlanAgainNotAvailableError';
  }
}

/**
 * A concurrent append claimed the same position on the thread. Turn order is
 * allocated under the session row's `SELECT … FOR UPDATE` lock with a re-read
 * inside the transaction, so two concurrent appends normally SERIALIZE into two
 * ordered turns; this error is what the `(session_id, seq)` unique backstop
 * becomes when that ordering is nonetheless lost (a desynced `turn_count`, a
 * writer that bypassed the lock). The point is that a raw Prisma `P2002` never
 * escapes the service — the caller gets a typed, retryable conflict. → 409
 */
export class PlanChangeTurnConflictError extends Error {
  readonly code = 'PLAN_CHANGE_TURN_CONFLICT' as const;
  constructor(sessionId: string, seq: number) {
    super(
      `Turn ${seq} on plan-change conversation ${sessionId} was claimed by a concurrent append; retry.`,
    );
    this.name = 'PlanChangeTurnConflictError';
  }
}

/**
 * A correction asked to re-run an ANSWERED turn as a plan change
 * (`conversation-turn-intent.md` AMENDMENT 3). Whether a turn becomes a
 * planning run is the planner's call alone, so that direction of the §3 flip is
 * retired: nothing is recorded and no job is submitted. A person who wants
 * changes says so in a new turn. → 422: the request names a re-run that is
 * not offered.
 */
export class PlanChangeFlipNotOfferedError extends Error {
  readonly code = 'PLAN_CHANGE_FLIP_NOT_OFFERED' as const;
  constructor(turnId: string) {
    super(
      `Turn ${turnId} was answered; it cannot be re-run as a plan change. Say what should change in a new turn.`,
    );
    this.name = 'PlanChangeFlipNotOfferedError';
  }
}

/** Submit was called on a thread with no `user` turns to submit — there is no
 *  intent to send (an empty conversation, or one holding only system markers).
 *  → 409: a state conflict, not a malformed request. */
export class EmptyPlanChangeIntentError extends Error {
  readonly code = 'PLAN_CHANGE_EMPTY_INTENT' as const;
  constructor(sessionId: string) {
    super(
      `Plan-change conversation ${sessionId} has no turns to submit — add what you want changed first.`,
    );
    this.name = 'EmptyPlanChangeIntentError';
  }
}

/**
 * A contextual planning turn named more anchors than one thread may carry
 * (7.12.3 · MOTIR-909). The scope is pushed to motir-ai as the UNION of every
 * anchor's neighborhood, so the bound is a real resource limit, not a style
 * preference — see `MAX_SCOPE_TARGETS`. → 400: the request is malformed, and no
 * retry of the same body will succeed.
 */
export class TooManyPlanChangeTargetsError extends Error {
  readonly code = 'PLAN_CHANGE_TOO_MANY_TARGETS' as const;
  constructor(count: number, max: number) {
    super(`A planning conversation can be anchored at at most ${max} work items (got ${count}).`);
    this.name = 'TooManyPlanChangeTargetsError';
  }
}

/**
 * Another planning session already holds one of this scope's targets (Story
 * MOTIR-2786 · MOTIR-2787). → 409: a state conflict, and a retryable one — the
 * body was fine, the item is simply taken.
 *
 * It NAMES the item and the holder, deliberately. "Planning is locked" with no
 * subject is an error a user cannot act on: with a scope of up to
 * `MAX_SCOPE_TARGETS` anchors they do not know WHICH of their targets is taken,
 * and with no holder they do not know whom to ask or whether to wait. The holder
 * name is nullable because the holding user may since have been deleted, and a
 * lease outliving its owner is exactly the case the expiry sweep exists for.
 */
export class PlanTargetLockedError extends Error {
  readonly code = 'PLAN_TARGET_LOCKED' as const;
  /**
   * WHEN the card frees, at the latest (AMENDMENT 23 §4; MOTIR-7639). For a
   * SESSION hold it is the lease's expiry plus one sweep interval — the idle
   * close ends the session on the first pass after the lease runs out. For a
   * PLAN hold it is null: a plan waiting for a decision frees when that plan is
   * decided, and no clock says when.
   */
  readonly freesBy: Date | null;
  /** The holding session, for a session hold — what the refusal links to. */
  readonly holderSessionId: string | null;
  /** Whether the holder's session is WAITING — on its person, or to resume — rather
   *  than merely holding (MOTIR-7912). A waiting hold has no free-by time: it frees
   *  when a person ends the session. */
  readonly sessionWaiting: boolean;
  /** WHY it waits: a planner's `question`, a conversation awaiting a `reply`, or a
   *  `failed` attempt waiting to resume; `null` when it is not waiting. */
  readonly waitingCause: PlanTargetWaitingCause | null;
  constructor(
    readonly targetIdentifier: string,
    readonly holderName: string | null,
    readonly expiresAt: Date,
    holder: {
      sessionId?: string | null;
      planId?: string | null;
      waitingCause?: PlanTargetWaitingCause | null;
    } = {},
  ) {
    const heldByPlan = !!holder.planId;
    const waitingCause = holder.waitingCause ?? null;
    const freesBy =
      heldByPlan || waitingCause
        ? null
        : new Date(expiresAt.getTime() + PLAN_TARGET_SWEEP_INTERVAL_MS);
    super(
      waitingCause
        ? `${targetIdentifier} is held by ${holderName ?? 'another member'}'s planning session, which is waiting on ${holderName ?? 'them'}.`
        : `${targetIdentifier} is being planned by ${holderName ?? 'another session'} right now. ` +
            (freesBy
              ? `The hold releases when that session ends, or by ${freesBy.toISOString()} at the latest.`
              : 'The hold releases when that plan is approved or declined.'),
    );
    this.name = 'PlanTargetLockedError';
    this.freesBy = freesBy;
    this.sessionWaiting = waitingCause !== null;
    this.waitingCause = waitingCause;
    this.holderSessionId = heldByPlan && !waitingCause ? null : (holder.sessionId ?? null);
  }
}

/** Why a holder's planning session waits (MOTIR-7912). */
export type PlanTargetWaitingCause = 'question' | 'reply' | 'failed';

/** One lock-sweep interval (`planTargetLockSweep`, every 5 minutes) — the slack
 *  between a session lease running out and the idle close ending the session. */
export const PLAN_TARGET_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** The turn body was empty / blank. → 400 */
export class EmptyPlanChangeTurnError extends Error {
  readonly code = 'PLAN_CHANGE_EMPTY_TURN' as const;
  constructor() {
    super('A plan-change turn cannot be empty.');
    this.name = 'EmptyPlanChangeTurnError';
  }
}

/**
 * A turn id that does not name a turn ON THIS THREAD (MOTIR-1818) — the read a
 * CORRECTION makes before it re-runs a turn under the other intent. Also what a
 * turn id from another tenant becomes: the lookup is scoped by session AND
 * workspace, so a foreign id is simply absent. → 404, the no-existence-leak
 * posture the rest of this file takes.
 */
export class PlanChangeTurnNotFoundError extends Error {
  readonly code = 'PLAN_CHANGE_TURN_NOT_FOUND' as const;
  constructor(turnId: string) {
    super(`No turn ${turnId} on this plan-change conversation.`);
    this.name = 'PlanChangeTurnNotFoundError';
  }
}

/**
 * A turn that holds no re-plan offer (or is not an assistant turn of the caller's
 * own guide conversation). → 404 `GUIDE_REPLAN_OFFER_NOT_FOUND`; one answer for
 * every way it can be wrong, so it never tells another member's offer apart from
 * a missing one (MOTIR-8689).
 */
export class GuideReplanOfferNotFoundError extends Error {
  readonly code = 'GUIDE_REPLAN_OFFER_NOT_FOUND' as const;
  constructor(turnId: string) {
    super(`No re-plan offer on turn ${turnId}.`);
    this.name = 'GuideReplanOfferNotFoundError';
  }
}

/**
 * The offer exists but can no longer be decided: a later turn superseded it
 * (MOTIR-8689), or a planning session was started from it. → 409
 * `GUIDE_REPLAN_OFFER_NOT_OPEN`.
 */
export class GuideReplanOfferNotOpenError extends Error {
  readonly code = 'GUIDE_REPLAN_OFFER_NOT_OPEN' as const;
  constructor(turnId: string) {
    super(`The re-plan offer on turn ${turnId} is no longer open.`);
    this.name = 'GuideReplanOfferNotOpenError';
  }
}

/**
 * A turn that holds no plan offer (MOTIR-9290), or is not in the caller's own
 * conversation. → 404 `PLAN_OFFER_NOT_FOUND`; one answer for every way it can be
 * wrong, so another member's offer never reads apart from a missing one.
 */
export class PlanOfferNotFoundError extends Error {
  readonly code = 'PLAN_OFFER_NOT_FOUND' as const;
  constructor(turnId: string) {
    super(`No plan offer on turn ${turnId}.`);
    this.name = 'PlanOfferNotFoundError';
  }
}

/**
 * The plan offer exists but can no longer be decided: a later answer superseded it,
 * or a planning session was started from it (MOTIR-9290). → 409
 * `PLAN_OFFER_NOT_OPEN`.
 */
export class PlanOfferNotOpenError extends Error {
  readonly code = 'PLAN_OFFER_NOT_OPEN' as const;
  constructor(turnId: string) {
    super(`The plan offer on turn ${turnId} is no longer open.`);
    this.name = 'PlanOfferNotOpenError';
  }
}

/** Why a start of a plan offer was refused (MOTIR-9291). `target_closed` is the
 *  lifecycle's own reason passed through; the other three only a start can find. */
export type PlanOfferStartRefusal =
  | 'target_not_available'
  | 'target_closed'
  | 'already_planning'
  | 'offer_not_open';

/**
 * A start of a plan offer — a Confirm, a typed yes, or a targeted "plan this" turn —
 * was refused before anything was claimed, appended or submitted (MOTIR-9291). The
 * offer stays as it was. → 409 `PLAN_OFFER_START_REFUSED` with `reason`.
 */
export class PlanOfferStartRefusedError extends Error {
  readonly code = 'PLAN_OFFER_START_REFUSED' as const;
  constructor(readonly reason: PlanOfferStartRefusal) {
    super(`The plan could not be started: ${reason}.`);
    this.name = 'PlanOfferStartRefusedError';
  }
}

/**
 * A second Confirm of a guide re-plan offer that already started a planning
 * session (MOTIR-8691). Carries that session's id so the client can open it
 * instead of starting again. → 409 `GUIDE_REPLAN_OFFER_CONFIRMED`.
 */
export class GuideReplanOfferAlreadyConfirmedError extends Error {
  readonly code = 'GUIDE_REPLAN_OFFER_CONFIRMED' as const;
  constructor(
    readonly turnId: string,
    readonly sessionId: string,
  ) {
    super(`The re-plan offer on turn ${turnId} already started session ${sessionId}.`);
    this.name = 'GuideReplanOfferAlreadyConfirmedError';
  }
}

/**
 * The work item an ask turn names as its ANCHOR (`anchorKey`, MOTIR-7047) does
 * not resolve for this caller: an unknown key, a key in another project or
 * workspace, or one they may not browse. ONE answer for all of them, and the same
 * body `GET /api/work-items/planning-anchor` gives — a 403 would say "it exists
 * but you can't see it". → 404 `NOT_FOUND`.
 */
export class AskAnchorNotAvailableError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor() {
    super('Work item not available.');
    this.name = 'AskAnchorNotAvailableError';
  }
}

/**
 * The card a `debug` turn would land on (MOTIR-7049) does not resolve for this
 * caller: the key `debug_bug` named as the existing card, or the anchor it echoed,
 * is unknown in the active project, in another project, or not one they may
 * browse. The same no-existence-leak answer as {@link AskAnchorNotAvailableError}
 * — and nothing was written. → 404 `NOT_FOUND`.
 */
export class DebugTargetNotAvailableError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor() {
    super('Work item not available.');
    this.name = 'DebugTargetNotAvailableError';
  }
}

/**
 * A `diagnose` result anchored on a card that is NOT an un-promoted triage `bug`
 * (MOTIR-7049). ADR AMENDMENT 1 · A1.4 lets a diagnosis be written onto the
 * anchored TRIAGE bug only; writing it onto any other card would be an enrichment
 * the duplicate search never chose. Nothing was written. → 422.
 */
export class DebugAnchorNotTriageBugError extends Error {
  readonly code = 'DEBUG_ANCHOR_NOT_TRIAGE_BUG' as const;
  constructor(readonly anchorKey: string) {
    super(`${anchorKey} is not a bug in Triage, so the diagnosis was not written onto it.`);
    this.name = 'DebugAnchorNotTriageBugError';
  }
}

/**
 * The card a `debug` turn was landing on changed underneath it (MOTIR-7049) — a
 * person edited it between the landing's read and its write, and the write
 * carries `expectedUpdatedAt`, so it was refused rather than overwriting them.
 * Nothing was written and the landing's claim was released, so settling the job
 * again retries it against the edited card. → 409.
 */
export class DebugTargetChangedError extends Error {
  readonly code = 'DEBUG_TARGET_CHANGED' as const;
  constructor(readonly workItemKey: string) {
    super(`${workItemKey} was edited while the diagnosis was being written. Try again.`);
    this.name = 'DebugTargetChangedError';
  }
}

// ── The BOUNDARY MAILBOX (Story MOTIR-4054 · MOTIR-4067) ────────────────────

/**
 * A turn was addressed to a planning job that is no longer RUNNING — it
 * succeeded, failed or was cancelled before the turn arrived. → 409: a state
 * conflict, and the one the card names outright, because the alternative is
 * worse than an error. A mailbox nobody will ever check accepts the turn, hands
 * the user a delivered-looking message, and then changes nothing for ever; the
 * refusal is what lets the composer say so.
 *
 * It NAMES the status, deliberately. "That run is over" leaves the client
 * guessing whether to resubmit as a new turn (succeeded / stopped) or to surface
 * a failure (failed), and those are opposite next steps.
 */
export class PlanChangeJobNotRunningError extends Error {
  readonly code = 'PLAN_CHANGE_JOB_NOT_RUNNING' as const;
  constructor(
    readonly jobId: string,
    readonly status: string,
  ) {
    super(
      `Planning job ${jobId} is ${status}, not running — there is no boundary left for this turn to be read at.`,
    );
    this.name = 'PlanChangeJobNotRunningError';
  }
}

/**
 * A turn was addressed to a job that is not the one THIS thread is running. →
 * 404, the no-existence-leak posture the rest of this file takes: from the
 * caller's side the job simply is not on their conversation.
 *
 * The check is not ceremony. `job_id` is an opaque motir-ai token and the
 * mailbox is keyed by `(session, job)`, so without it a caller who learned any
 * job id could attach a turn under their OWN session addressed at somebody
 * else's run — invisible to them, and read by nobody, but a row that exists.
 * Binding the turn to the thread's own `last_job_id` is what makes the address
 * derivable rather than asserted.
 */
export class PlanChangeMailboxJobMismatchError extends Error {
  readonly code = 'PLAN_CHANGE_MAILBOX_JOB_MISMATCH' as const;
  constructor(readonly jobId: string) {
    super(`Job ${jobId} is not the run this plan-change conversation is on.`);
    this.name = 'PlanChangeMailboxJobMismatchError';
  }
}

/**
 * A Plans-list `cursor` this read did not mint (MOTIR-6025) — undecodable, or
 * naming no `(lastActivityAt, id)` pair. A cursor is opaque, so a malformed one
 * is a client error, never an empty page. → 400
 */
export class InvalidPlanSessionCursorError extends Error {
  readonly code = 'INVALID_PLAN_SESSION_CURSOR' as const;
  constructor() {
    super('The planning conversations cursor is not valid. Request the first page again.');
    this.name = 'InvalidPlanSessionCursorError';
  }
}

/**
 * A SEEDED first turn named a gate that may not seed this session (story
 * MOTIR-6068 · MOTIR-6207; `agent-authored-plans.md` AMENDMENT 17 §9). One error
 * for every way the seed fails the guard — the gate is missing or in another
 * workspace or project, it is not a refusal `isRefusalSeedGate` accepts, or it
 * belongs to a work item the turn's scope does not anchor on — so the refusal
 * never distinguishes a hidden gate from an absent one. Nothing is written when
 * it is thrown. → 422 `SEED_NOT_APPLICABLE` (the route mapping is MOTIR-6210's).
 */
export class PlanSeedNotApplicableError extends Error {
  // `seedGateId` holds whichever seed reference was refused: a gate id, or (for a
  // guide-seeded start, MOTIR-8691) the guide reply turn id. The wire code is one.
  readonly code = 'PLAN_SEED_NOT_APPLICABLE' as const;
  constructor(readonly seedGateId: string) {
    super(`Gate ${seedGateId} cannot seed a planning session on this scope.`);
    this.name = 'PlanSeedNotApplicableError';
  }
}

/**
 * The REFUSAL SEED read found nothing to offer THIS viewer (story MOTIR-6068 ·
 * MOTIR-6208; `approval-gates.md` §10f). ONE error for every way the read fails
 * — the gate id is unknown, the gate lives in another workspace or project, its
 * work item is not browsable by the viewer, it is not a refusal
 * `isRefusalSeedGate` accepts, or its kind has no composer — so an answer never
 * distinguishes a gate that exists but is hidden from one that does not exist.
 * It carries NO gate fields and no reason text. → 404 `{ code: 'NOT_FOUND' }`.
 */
export class PlanningSeedNotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor() {
    super('No planning seed is available for this gate.');
    this.name = 'PlanningSeedNotFoundError';
  }
}

/**
 * Resume asked by someone who is NOT the session's owner (Story MOTIR-7905 · MOTIR-7916).
 * The decision routes everything about a waiting session to its owner, so only the owner
 * resumes it; a member who can see it gets this rather than a 404, because the design draws
 * a "no longer the owner" refusal. → 403.
 */
export class NotSessionOwnerError extends Error {
  readonly code = 'NOT_SESSION_OWNER' as const;
  constructor(readonly sessionId: string) {
    super(
      `Only the person who started planning session ${sessionId}, or a project manager, can resume it.`,
    );
    this.name = 'NotSessionOwnerError';
  }
}

/** Resume asked of an open session that is NOT failed-waiting (MOTIR-7916). → 409. */
export class SessionNotFailedError extends Error {
  readonly code = 'SESSION_NOT_FAILED' as const;
  constructor(readonly sessionId: string) {
    super(`Planning session ${sessionId} has no failed attempt to resume.`);
    this.name = 'SessionNotFailedError';
  }
}

/**
 * A concurrent Resume already started the new attempt (MOTIR-7916). Carries the WINNING
 * job's id, so a double-click streams the one attempt that is running. → 409.
 */
export class ResumeAlreadyStartedError extends Error {
  readonly code = 'RESUME_ALREADY_STARTED' as const;
  constructor(
    readonly sessionId: string,
    readonly jobId: string | null,
  ) {
    super(`Planning session ${sessionId} was already resumed.`);
    this.name = 'ResumeAlreadyStartedError';
  }
}

/**
 * The session's latest plan is not the one the failure belongs to, or is no longer
 * `generating` (MOTIR-7916): there is nothing for a resume to continue. → 409.
 */
export class PlanNotResumableError extends Error {
  readonly code = 'PLAN_NOT_RESUMABLE' as const;
  constructor(readonly sessionId: string) {
    super(`Planning session ${sessionId} has no plan that can be resumed.`);
    this.name = 'PlanNotResumableError';
  }
}

/**
 * An ordinary planning submit on a failed-waiting session (MOTIR-7916): it would open a
 * second plan beside the one the session holds, so the only ways on are Resume or ending the
 * session. → 409 `SESSION_AWAITING_RESUME`.
 */
export class PlanSessionAwaitingResumeError extends Error {
  readonly code = 'SESSION_AWAITING_RESUME' as const;
  constructor(readonly sessionId: string) {
    super(`Planning session ${sessionId} is waiting to resume; resume it or start a new one.`);
    this.name = 'PlanSessionAwaitingResumeError';
  }
}

/**
 * A guide turn on a card that is not MANUAL (Story MOTIR-7459 · MOTIR-7464; ADR
 * `conversation-turn-intent.md` AMENDMENT 2, A2.7). The predicate is
 * `isManualReadyItem` — `executor: human` or `type: manual` — and the turn is
 * refused BEFORE anything is written or submitted. → 422 `GUIDE_CARD_NOT_MANUAL`.
 */
export class GuideCardNotManualError extends Error {
  readonly code = 'GUIDE_CARD_NOT_MANUAL' as const;
  constructor(readonly identifier: string) {
    super(`${identifier} is not a manual work item, so Motir AI cannot guide it.`);
    this.name = 'GuideCardNotManualError';
  }
}

/**
 * A guide turn on a card that is already finished — in a `done`-category status,
 * or archived (A2.7: the door shows only where the card is open). Refused before
 * anything is written or submitted. → 409 `GUIDE_CARD_CLOSED`.
 */
export class GuideCardClosedError extends Error {
  readonly code = 'GUIDE_CARD_CLOSED' as const;
  constructor(
    readonly identifier: string,
    readonly reason: 'done' | 'archived',
  ) {
    super(
      reason === 'archived'
        ? `${identifier} is archived, so there is nothing left to guide.`
        : `${identifier} is already finished, so there is nothing left to guide.`,
    );
    this.name = 'GuideCardClosedError';
  }
}

/**
 * A planning submit addressed at a GUIDE conversation (MOTIR-7464; ADR
 * AMENDMENT 2, A2.1/A2.2). A guide conversation is session-scoped to one intent
 * and never submits a plan — to plan, the person opens Motir AI from the orb,
 * which is a different conversation. → 409 `GUIDE_SESSION_NOT_PLANNABLE`.
 */
export class GuideSessionNotPlannableError extends Error {
  readonly code = 'GUIDE_SESSION_NOT_PLANNABLE' as const;
  constructor(readonly sessionId: string) {
    super('A guide conversation does not submit a plan.');
    this.name = 'GuideSessionNotPlannableError';
  }
}

/**
 * A guide conversation has already filed `GUIDE_BUGS_PER_CONVERSATION` bugs
 * through its `file_bug` action (Story MOTIR-7797 · MOTIR-7800; decision
 * MOTIR-7798 Q3, the VOLUME bound). Counted on `plan_change_session.guide_bugs_filed`
 * under the session's row lock. The landing records it as a skipped action with
 * this reason; it never fails the turn.
 */
export class GuideBugCapExceededError extends Error {
  readonly code = 'GUIDE_BUG_CAP_EXCEEDED' as const;
  constructor(
    readonly sessionId: string,
    readonly cap: number,
    readonly filed: number,
  ) {
    super(
      `This guide conversation has already filed ${filed} bugs; the most it may file is ${cap}.`,
    );
    this.name = 'GuideBugCapExceededError';
  }
}

/**
 * A guide's `file_bug` names a bug that is already filed: a not-done bug of the
 * project, linked `relates_to` the guided card, carries the same title (trimmed,
 * case-insensitive) — MOTIR-7800, decision MOTIR-7798 Q3 "Duplicates". Nothing is
 * filed; the landing records the existing bug's key on the skipped outcome.
 */
export class GuideBugDuplicateError extends Error {
  readonly code = 'GUIDE_BUG_DUPLICATE' as const;
  constructor(readonly existingKey: string) {
    super(`This bug is already filed as ${existingKey}.`);
    this.name = 'GuideBugDuplicateError';
  }
}

/**
 * A turn carrying files on a conversation that is not a GUIDE conversation
 * (Story MOTIR-7471 · MOTIR-7484; `docs/decisions/guide-turn-files.md` A3.2 /
 * A3.7). Only a guide conversation has one card to attach a file to; `ask`,
 * `plan_change` and `debug` turns stay text only. Refused before anything is
 * written or submitted. → 400 `TURN_FILES_GUIDE_ONLY`.
 */
export class TurnFilesGuideOnlyError extends Error {
  readonly code = 'TURN_FILES_GUIDE_ONLY' as const;
  constructor() {
    super('Only a guide conversation takes files.');
    this.name = 'TurnFilesGuideOnlyError';
  }
}

/**
 * A guide turn's files refused as a whole (MOTIR-7484; A3.2 / A3.3): more than
 * four, a repeated id, or an id that is not an attachment on the guided card in
 * the caller's workspace. Refused before the turn is written or any job runs, so
 * no turn is sent. → 400 `GUIDE_TURN_FILES_REFUSED`, with `reason`.
 */
export class GuideTurnFilesRefusedError extends Error {
  readonly code = 'GUIDE_TURN_FILES_REFUSED' as const;
  constructor(
    readonly reason: 'too_many' | 'duplicate' | 'not_on_card',
    readonly attachmentId: string | null = null,
  ) {
    super(
      reason === 'too_many'
        ? 'A guide turn carries at most 4 files.'
        : reason === 'duplicate'
          ? 'A guide turn names each file once.'
          : 'A file on a guide turn must be an attachment on the guided card.',
    );
    this.name = 'GuideTurnFilesRefusedError';
  }
}

// ── THE PLANNER'S MID-RUN PAUSE (Story MOTIR-7990 · MOTIR-8007) ──────────────────

/** A pause addressed by id that is not on this session and job (or does not exist).
 *  One error for both, the no-existence-leak posture. → 404 */
export class PlanChangeRunPauseNotFoundError extends Error {
  readonly code = 'PLAN_CHANGE_RUN_PAUSE_NOT_FOUND' as const;
  constructor(readonly pauseId: string) {
    super(`No run pause ${pauseId} exists on this conversation's run.`);
    this.name = 'PlanChangeRunPauseNotFoundError';
  }
}

/** A pause recorded or answered with the wrong shape: a kind without its own text
 *  field, or a choice that does not fit the pause's kind. Nothing was written. → 400 */
export class PlanChangeRunPauseShapeError extends Error {
  readonly code = 'PLAN_CHANGE_RUN_PAUSE_SHAPE' as const;
  constructor(readonly reason: string) {
    super(`The run pause request is malformed: ${reason}`);
    this.name = 'PlanChangeRunPauseShapeError';
  }
}

/** The pause was already answered, and not with this choice. Carries the stored
 *  answer so the surface can show what stands. → 409 */
export class PlanChangeRunPauseAnsweredError extends Error {
  readonly code = 'PLAN_CHANGE_RUN_PAUSE_ANSWERED' as const;
  constructor(
    readonly pauseId: string,
    readonly answer: string,
  ) {
    super(`Run pause ${pauseId} was already answered (${answer}).`);
    this.name = 'PlanChangeRunPauseAnsweredError';
  }
}

/** The planner tried to pause a run whose plan was already decided. → 409 */
export class PlanChangeRunPausePlanDecidedError extends Error {
  readonly code = 'PLAN_CHANGE_RUN_PAUSE_PLAN_DECIDED' as const;
  constructor(
    readonly planId: string,
    readonly planStatus: string,
  ) {
    super(`Plan ${planId} is ${planStatus}: there is nothing left to pause on.`);
    this.name = 'PlanChangeRunPausePlanDecidedError';
  }
}

/** A pause named a change turn that is not a mailbox entry of THIS session and
 *  job. → 409 */
export class PlanChangeRunPauseTurnMismatchError extends Error {
  readonly code = 'PLAN_CHANGE_RUN_PAUSE_TURN_MISMATCH' as const;
  constructor(readonly turnId: string) {
    super(`Change turn ${turnId} is not on this run's mailbox.`);
    this.name = 'PlanChangeRunPauseTurnMismatchError';
  }
}
