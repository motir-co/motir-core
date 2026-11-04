// The REVIEW RUN's own refusals (Story MOTIR-1626 · MOTIR-6821; ADR
// `docs/decisions/hosted-agent-run.md` §8.2 / §8.4, `approval-gates.md` §12.3 / §12.5).
//
// Raised by `agentReviewRunService` — the review prompt read and the verdict route —
// and mapped to v1 statuses by CODE in `lib/api/v1/errors.ts`'s `DOMAIN_ERROR_STATUS`.
// A refusal of the card BINDING (a review run's token naming another card) is not here:
// it is the shared `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE`, raised by `runTokenScopeService`
// exactly as for every other run-token route.

/**
 * 403 — the caller is not a REVIEW run's own credential. Both review routes answer only
 * the token of a `command: review` run (`hosted-agent-run.md` §3's pointer): a person's
 * PAT, a CLI device token, and a BUILD run's token (`run`, `continue`, `fix`, …) are all
 * refused here, before anything about the card is read.
 */
export class ReviewRunTokenRequiredError extends Error {
  readonly code = 'REVIEW_RUN_TOKEN_REQUIRED';
  constructor() {
    super(
      'Only a hosted review run’s own credential may read the review prompt or submit a verdict.',
    );
    this.name = 'ReviewRunTokenRequiredError';
  }
}

/**
 * 404 — the card has no `agent_review` gate at all, so there is nothing to review and no
 * question a verdict could answer. A card with a withdrawn or decided review is NOT this:
 * that verdict is late ({@link ReviewStaleError}).
 */
export class ReviewGateNotFoundError extends Error {
  readonly code = 'REVIEW_GATE_NOT_FOUND';
  constructor(readonly workItemKey: string) {
    super(`${workItemKey} has no agent review to answer.`);
    this.name = 'ReviewGateNotFoundError';
  }
}

/**
 * 409 — this run has already submitted its ONE verdict (`hosted-agent-run.md` §8.4). The
 * first verdict the run submitted — accepted or recorded late — ends the question for the
 * run; a second is refused and recorded nowhere.
 */
export class ReviewVerdictAlreadySubmittedError extends Error {
  readonly code = 'REVIEW_VERDICT_ALREADY_SUBMITTED';
  constructor(readonly dispatchRunId: string) {
    super('This review run has already submitted its verdict.');
    this.name = 'ReviewVerdictAlreadySubmittedError';
  }
}

/** Why a verdict was LATE — what the gate had become by the time it arrived. */
export type ReviewStaleCause =
  /** The version the run names is not the gate's, or the set moved under it. */
  | 'stale_version'
  /** The review was withdrawn — a head move, a close, a red build, the switch (§12.5). */
  | 'superseded'
  /** The gate was already decided — a person continued without the review (§12.3). */
  | 'already_decided';

/**
 * 409 — a LATE verdict (`approval-gates.md` §12.5): a version that is not the gate's, a
 * gate already superseded, or one already decided. It was RECORDED on the run (a
 * `review_verdict` event naming the verdict and the version) and decided nothing.
 */
export class ReviewStaleError extends Error {
  readonly code = 'REVIEW_STALE';
  constructor(
    readonly staleCause: ReviewStaleCause,
    readonly subjectVersion: string,
  ) {
    super(
      staleCause === 'superseded'
        ? 'The review was withdrawn before this verdict arrived; it was recorded on the run and decided nothing.'
        : staleCause === 'already_decided'
          ? 'The review was already decided; this verdict was recorded on the run and decided nothing.'
          : 'This verdict is about a version the review is no longer asking about; it was recorded on the run and decided nothing.',
    );
    this.name = 'ReviewStaleError';
  }
}

// ── REVIEW AGAIN (Story MOTIR-1626 · MOTIR-6820; `approval-gates.md` §12.6) ──────────────
//
// The routed person's press on a review that COULD NOT RUN. Raised by
// `agentReviewStartService.reviewAgain` and mapped by the session route
// `POST /api/approval-gates/[id]/review-again`.

/**
 * 404 — no `agent_review` gate by that id that the caller can see: missing, another
 * workspace, a card the caller cannot browse, or a gate of another kind. One answer for
 * all of them, so the route leaks no existence.
 */
export class ReviewAgainGateNotFoundError extends Error {
  readonly code = 'REVIEW_AGAIN_GATE_NOT_FOUND';
  constructor(readonly gateId: string) {
    super('There is no agent review here to run again.');
    this.name = 'ReviewAgainGateNotFoundError';
  }
}

/**
 * 403 — the caller may see the card but is not the person the review is routed to (the
 * assignee, the reporter when there is no assignee, or `approval:decide_any`), or lacks
 * the kind's `work_item:edit` floor — the SAME authority *Continue without the review*
 * takes (§12.3, §12.6).
 */
export class ReviewAgainForbiddenError extends Error {
  readonly code = 'REVIEW_AGAIN_FORBIDDEN';
  constructor(readonly gateId: string) {
    super('Only the person this review is routed to can run it again.');
    this.name = 'ReviewAgainForbiddenError';
  }
}

/** Why *Review again* is not offered on this gate right now. */
export type ReviewAgainRefusal =
  /** The gate is no longer awaiting — decided, or withdrawn by a head move or the switch. */
  | 'not_awaiting'
  /** The review has not failed to run: there is no `reviewUnavailableReason` to clear. */
  | 'no_reason'
  /** A review run for this gate is still running — one review at a time. */
  | 'run_in_flight'
  /** The project's review source is `own`: no hosted run is started (§12.6, §12.10). */
  | 'source_own';

/** What each refusal tells the person. */
const REVIEW_AGAIN_REFUSAL_MESSAGES: Record<ReviewAgainRefusal, string> = {
  not_awaiting: 'This review is no longer waiting, so it cannot be run again.',
  no_reason: 'This review has not failed to run, so there is nothing to run again.',
  run_in_flight: 'A review of this version is already running.',
  source_own:
    'This project reviews with your own agent, so Motir does not start a review run. Run `motir review` from your agent.',
};

/**
 * 409 — *Review again* is offered only on an AWAITING review that could not run and has
 * no run in flight (§12.6). Nothing was cleared and nothing was requested.
 */
export class ReviewAgainNotOfferedError extends Error {
  readonly code = 'REVIEW_AGAIN_NOT_OFFERED';
  constructor(
    readonly gateId: string,
    readonly reason: ReviewAgainRefusal,
  ) {
    super(REVIEW_AGAIN_REFUSAL_MESSAGES[reason]);
    this.name = 'ReviewAgainNotOfferedError';
  }
}
