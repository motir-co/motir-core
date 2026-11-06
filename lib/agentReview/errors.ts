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
    /** The bugs the late verdict still logged (MOTIR-10513) — a bug outlives a moved head. */
    readonly loggedBugKeys: readonly string[] = [],
  ) {
    super(
      (staleCause === 'superseded'
        ? 'The review was withdrawn before this verdict arrived; it was recorded on the run and decided nothing.'
        : staleCause === 'already_decided'
          ? 'The review was already decided; this verdict was recorded on the run and decided nothing.'
          : 'This verdict is about a version the review is no longer asking about; it was recorded on the run and decided nothing.') +
        (loggedBugKeys.length > 0 ? ` The bugs it logged stand: ${loggedBugKeys.join(', ')}.` : ''),
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

// ── THE USER-TOKEN VERDICT DOOR (Story MOTIR-10327 · MOTIR-10333; `approval-gates.md`
// §12.11–§12.13) ───────────────────────────────────────────────────────────────────────
//
// Raised by `reviewVerdictService.submit`, the one service behind the MCP tool
// `submit_review_verdict` and `POST /api/v1/work-items/{key}/review-verdict`. Mapped by
// code (`lib/api/v1/errors.ts`, `lib/mcp/toolResult.ts`). `ReviewStaleError` above is not
// reused: it speaks of a RUN, and this door's caller is a person's own agent.

/**
 * 422 — the card is not a RUN TARGET (§12.11): its tests are its ancestor's, so the
 * review is that ancestor's to receive. The refusal names it. Nothing was stored.
 */
export class ReviewTargetNotRunTargetError extends Error {
  readonly code = 'REVIEW_TARGET_NOT_RUN_TARGET';
  constructor(
    readonly workItemKey: string,
    readonly runTargetKey: string,
  ) {
    super(
      `${workItemKey} is reviewed as part of ${runTargetKey}, its run target. Submit the verdict for ${runTargetKey}.`,
    );
    this.name = 'ReviewTargetNotRunTargetError';
  }
}

/**
 * 422 — the verdict is malformed in a way only the service can see, or that a transport
 * did not check first: no findings on a send-back, a `met` row without evidence, an
 * empty harness or model. `field` names it. Nothing was stored.
 */
export class ReviewVerdictInvalidError extends Error {
  readonly code = 'INVALID_REVIEW_VERDICT';
  constructor(
    readonly field: string,
    readonly problem: string,
  ) {
    super(`\`${field}\` ${problem}.`);
    this.name = 'ReviewVerdictInvalidError';
  }
}

/**
 * 404 — the card delivers no pull request, so it has no delivery-set version a review
 * could be about. Nothing was stored.
 */
export class ReviewNothingToReviewError extends Error {
  readonly code = 'REVIEW_NOTHING_TO_REVIEW';
  constructor(readonly workItemKey: string) {
    super(`${workItemKey} delivers no pull request, so there is nothing to review.`);
    this.name = 'ReviewNothingToReviewError';
  }
}

/**
 * 409 — a LATE verdict (§12.13): it names a version that is not the card's current
 * delivery-set version. It was STORED as `late` and decided nothing.
 */
export class ReviewVerdictLateError extends Error {
  readonly code = 'REVIEW_VERDICT_LATE';
  constructor(
    readonly subjectVersion: string,
    /** The card's current version, when the door read it; null when the set moved under
     *  the decide itself. */
    readonly currentVersion: string | null,
  ) {
    super(
      'This verdict is about a version the card no longer has: a push moved it. It was recorded as late and decided nothing. Review the current version.',
    );
    this.name = 'ReviewVerdictLateError';
  }
}

/**
 * 409 — a SECOND verdict (§12.13): the version already has a decided review or a stored
 * verdict. It was STORED as `second` and decided nothing.
 */
export class ReviewVerdictSecondError extends Error {
  readonly code = 'REVIEW_VERDICT_SECOND';
  constructor(readonly subjectVersion: string) {
    super(
      'This version has already been reviewed. The verdict was recorded as a second review and decided nothing.',
    );
    this.name = 'ReviewVerdictSecondError';
  }
}

/**
 * INTERNAL — an answering verdict (`decided` / `recorded`) already exists for the
 * (card, version): the partial unique index's refusal, translated by the repository. The
 * services catch it and store the verdict as `second`; it never reaches a caller.
 */
export class ReviewVerdictAnswerExistsError extends Error {
  readonly code = 'REVIEW_VERDICT_ANSWER_EXISTS';
  constructor(
    readonly workItemId: string,
    readonly subjectVersion: string,
  ) {
    super('This version already has an answering review verdict.');
    this.name = 'ReviewVerdictAnswerExistsError';
  }
}

// ── DISMISS THE REVIEW (Story MOTIR-10327 · MOTIR-10334; `approval-gates.md` §12.15) ───────
//
// Raised by `reviewDismissalService.dismiss`, behind
// `POST /api/v1/work-items/{key}/review-dismissal`. Each is raised BEFORE anything is
// written, except the already-dismissed backstop, whose transaction rolls back.

/** 403 — the caller is not the routed person (§12.3's authority set). Nothing was written. */
export class ReviewDismissalForbiddenError extends Error {
  readonly code = 'REVIEW_DISMISSAL_FORBIDDEN';
  constructor(readonly workItemKey: string) {
    super(
      `Only the person ${workItemKey}'s approvals are routed to — its assignee, its reporter when it has no assignee, or someone who may decide any approval — can dismiss its review.`,
    );
    this.name = 'ReviewDismissalForbiddenError';
  }
}

/** 422 — the reason is empty once trimmed, or longer than the limit. Nothing was written. */
export class ReviewDismissalReasonRequiredError extends Error {
  readonly code = 'REASON_REQUIRED';
  constructor(readonly maxLength: number) {
    super(`A reason is required to dismiss the review, at most ${maxLength} characters.`);
    this.name = 'ReviewDismissalReasonRequiredError';
  }
}

/** 409 — no agent send-back stands at the card's current version. Nothing was written. */
export class ReviewSendBackNotStandingError extends Error {
  readonly code = 'NO_STANDING_REVIEW_SENDBACK';
  constructor(readonly workItemKey: string) {
    super(`${workItemKey} has no review agent send-back standing at its current version.`);
    this.name = 'ReviewSendBackNotStandingError';
  }
}

/**
 * 409 — the dismissal names a version the card no longer has: a push moved it, so the
 * send-back it meant has already ended. Nothing was written.
 */
export class ReviewDismissalStaleError extends Error {
  readonly code = 'REVIEW_DISMISSAL_STALE';
  constructor(
    readonly subjectVersion: string,
    /** The card's current version, or null when it delivers no pull request. */
    readonly currentVersion: string | null,
  ) {
    super(
      'This dismissal is about a version the card no longer has: a push moved it, and the send-back it meant has already ended.',
    );
    this.name = 'ReviewDismissalStaleError';
  }
}

/** 409 — the send-back at this version was already dismissed. Nothing was written. */
export class ReviewSendBackAlreadyDismissedError extends Error {
  readonly code = 'REVIEW_SENDBACK_ALREADY_DISMISSED';
  constructor(readonly subjectVersion: string) {
    super('The review agent’s send-back at this version has already been dismissed.');
    this.name = 'ReviewSendBackAlreadyDismissedError';
  }
}

/**
 * 404 — the review a *Findings and checklist* link names is not one of this card's: no
 * such verdict record or `agent_review` gate, or one on another card or in another
 * workspace. The same answer as a card the reader cannot see, so it leaks nothing.
 */
export class ReviewFindingsNotFoundError extends Error {
  readonly code = 'REVIEW_FINDINGS_NOT_FOUND';
  constructor(readonly workItemKey: string) {
    super(`${workItemKey} has no such review.`);
    this.name = 'ReviewFindingsNotFoundError';
  }
}
