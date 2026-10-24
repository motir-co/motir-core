'use client';

import { GUIDE_OFFER_CLOSED } from '@/lib/planning/guideOfferClosed';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CopyableSessionDto,
  EarlierSessionDto,
  PlanChangeRunPauseDto,
  PlanChangeSessionDto,
  PlanTargetHeldByDto,
} from '@/lib/dto/planChange';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { mergePlanReview } from '@/lib/planning/mergePlanReview';
import type { PlanNarrationDto, PlanNarrationReadDto } from '@/lib/dto/plans';
import {
  liveNarrationSessions,
  mergeNarrationEntries,
  narrationEarlierCount,
} from '@/components/planning/planNarration';
import { announceGateStateDecided } from '@/lib/approvals/decidedGates';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import { useGeneratingPlanPoll } from '@/lib/hooks/useGeneratingPlanPoll';
import {
  findResumableSession,
  getPlanChangeSession,
  recordPlannerTurn,
  rerunAskTurn,
  resubmitContextualPlan,
  resumeContextualSession,
  settleAskJob,
  submitMidRunAskTurn,
  submitLateChanges,
  startCopiedSession,
  requestRestartConfirm,
  answerRestart,
  answerPlanOffer,
  submitAskTurn,
  submitContextualPlan,
  attachMidRunTurn,
  peekMailbox,
  resumeAlreadyStartedJobId,
  resumePlanSession,
  stopPlanChangeRun,
  submitPlanChange,
  type AskRedirectResponse,
  type AskSettleResponse,
  type AskSubmitResponse,
} from '@/lib/planning/planChangeClient';
import {
  latestTurnDeclined,
  latestTurnUnsearchable,
  pendingQuestion,
} from '@/lib/planning/planChangeThread';
import { isOpenUnclear, pauseOf, MAILBOX_POLL_MS } from '@/lib/planning/runPause';
import { useRunPause } from '@/lib/hooks/useRunPause';
import { carriesWaitingPlan } from '@/lib/planning/sessionCarry';
import {
  PlanAgainNotAvailableClientError,
  PlanSessionPlanDecidedClientError,
  PlanSessionPlanStaleClientError,
  type StalePlanFinishedCard,
} from '@/lib/planning/planSessionClientErrors';
import { FRAME_DISPOSITIONS, isKnownFrameKind } from '@/lib/planning/planChangeFrames';
import { unavailableCodeOf, whileStartingUp } from '@/lib/planning/submitStartingUp';
import { reopenedPlanJobId } from '@/lib/planning/planRunPhase';
import {
  streamAskJob,
  streamAugmentJob,
  streamContextualPlanJob,
  PlanEditsClientError,
} from '@/lib/planning/planEditsClient';
import {
  approvePlanRequest,
  declinePlanRequest,
  fetchPlanNarrationPage,
  fetchPlanReview,
  PlanRequestError,
} from '@/lib/planning/planReviewClient';
import {
  planDecisionErrorCode,
  readPendingProposal,
  summarizePlanApproval,
  type PlanApproveSummary,
} from '@/lib/planning/planReview';
import {
  extraPlanningTargetKeys,
  primaryPlanningTarget,
  type PlanningTarget,
} from '@/lib/planning/planningTargets';

// The client state machine behind the plan-change CONVERSATION rail (Subtask
// MOTIR-1730; design `plan-change-conversation.mock.html` panels 3 / 4 / 6). It
// drives the whole loop over ALREADY-SHIPPED surfaces:
//
//   mount    → POST /api/ai/plan-change/session      (open OR RESUME the thread)
//   a turn   → POST …/session/turns  (accumulate)  → POST …/session/submit
//   running  → GET  /api/ai/augment/[jobId]/stream  (the shipped SSE)
//   settled  → GET  /api/plans/[planId]             (the run's PROPOSALS)
//   approve  → POST /api/plans/[planId]/approve     (materialize — the write)
//   discard  → POST /api/plans/[planId]/decline
//
// ⚠️ It reviews the PLAN, not the job's `planDelta` (MOTIR-1746). Every plan-edit
// handler in motir-ai returns `planDelta: { operations: [] }` and writes its
// output as `PlanItem` proposals instead (`addProposals` → `markPlanned`), so the
// delta read always fell through to `EMPTY`: the user was told nothing was
// proposed while the proposals sat in the Plan store unread, and the Approve
// could never fire. The engine's invariant is that ALL planning appends to a Plan
// — whoever triggered it — so this reads and confirms that Plan, through the same
// route `/plans/[id]` uses. Two entrances, ONE gate.
//
// Three things this deliberately does NOT do:
//  • it does not re-implement the review read or the approve — those are
//    `planReviewClient`'s shipped helpers, the same ones the plan-detail island
//    calls (the compose-don't-reinvent rule);
//  • it does not close on approve — `approved` is recorded and the phase returns
//    to `idle` with the THREAD INTACT, which is what makes this a conversation
//    rather than a transaction (design panel 6, "after approve");
//  • it does not clear a pending proposal on a FAILED run: the design's error
//    state is "recoverable in place — the thread and any prior proposal survive",
//    so a retry continues the conversation instead of restarting it.
//
// ⚠️ Streaming, against shipped reality: the `augment` job's SSE carries
// STRUCTURED PROGRESS frames (`search` / `drill` / `level_complete` / `pass` /
// `planned` / `validated`), NOT assistant tokens — token streaming belongs to the
// onboarding conductor, a different job kind. So `progress` is the narration
// derived from those real frames, rendered into the rail's `aria-live` region
// with the shipped drafting spinner. Faking a token stream would mean an engine
// change, which this card explicitly does not make.

/** `deciding` covers BOTH decisions: approve and discard are now server writes
 *  against the Plan (materialize / decline), so the gate must read busy for
 *  either — a Discard that looked idle mid-POST could be double-fired. */
export type PlanChangePhase = 'loading' | 'idle' | 'streaming' | 'review' | 'deciding';

/** One turn typed mid-run, and whether the run has taken it yet. */
export interface QueuedTurn {
  /** The mailbox entry's id — what the peek is matched against. */
  id: string;
  text: string;
  /** The run consumed it at a phase boundary. */
  read: boolean;
}

/** A progress frame the run narrates while the job works. */
export type PlanChangeProgress =
  | { kind: 'submitted' }
  /** The submit has waited long on a waking Motir AI (MOTIR-9255): the server
   *  re-sends it under one key meanwhile, so this is a wait, never an error. Taken
   *  back down the moment the submit answers. */
  | { kind: 'starting' }
  /** An ask turn is being READ — the first phase of the one door, before Motir
   *  knows whether it is answering or planning. */
  | { kind: 'reading' }
  /** The ask job settled saying the turn was a PLAN CHANGE, and the run has
   *  attached to the plan-edit job (ADR Consequence 3). The rail names the
   *  hand-off here rather than letting the user watch a spinner stop and a
   *  different one start. */
  | { kind: 'redirected' }
  /** A level being laid, and one card being written. */
  | { kind: 'laying'; target: string | null }
  | { kind: 'authoring'; title: string | null }
  /** The planner's OWN prose line for the act it just took. The producer emits
   *  nothing when the text is blank, so this is never an empty row. */
  | { kind: 'note'; text: string }
  | { kind: 'proposed'; count: number }
  | { kind: 'validating' };

/** What an approve landed, as the rail says it back — the shared summary every
 *  confirming surface reports (`planReviewClient`), re-exported here because the
 *  rail's components type their `onApproved` against the hook. */
export type { PlanApproveSummary };

export interface PlanChangeConversationState {
  phase: PlanChangePhase;
  /** The persisted thread — the resume payload, re-read on mount. */
  session: PlanChangeSessionDto | null;
  /** The live narration of the running job (the `aria-live` line). */
  progress: PlanChangeProgress | null;
  /**
   * THE ACT RAIL — every act this run has narrated, in order (MOTIR-4069).
   *
   * ⚠️ AN ACCUMULATING RECORD, where {@link progress} is a REPLACING line, and
   * the difference is the point. A run used to say one sentence at a time and
   * overwrite it, so its whole history was one sentence long. The user is now
   * making a decision against this — whether to stop it — and a decision needs
   * the record rather than the latest word
   * (`design/ai-chat/plan-change-run-live.mock.html` sheet 3).
   *
   * `progress` survives as the LIVE line: the newest act, which the pinned
   * running bar repeats so it is on screen however far the transcript is
   * scrolled.
   *
   * Never re-ordered, never collapsed, never de-duplicated: two `retrieval`
   * lines in a row mean the planner made two lookups, and folding them into
   * "2 lookups" turns a record into a summary.
   */
  acts: PlanChangeProgress[];
  /**
   * The run's PROPOSALS, read from its Plan — what the canvas draws and what the
   * gate confirms.
   *
   * ⚠️ IT SURVIVES THE DECISION (MOTIR-3162; bug MOTIR-3154). Approve and
   * discard each used to set it `null`, and `PlanningWorkspaceHost` derives its
   * ENTIRE diff index from this one field — so the overlay vanished the instant
   * a decision was taken. After an approve the items at least remained as
   * ordinary committed cards, so the canvas merely stopped saying which of them
   * you had just accepted; after a DISCARD nothing remained at all, and the
   * conversation that produced the tree was still on screen beside the space
   * where the tree had been.
   *
   * It is now cleared only when a NEW run starts, which is the moment it stops
   * describing anything. What the decision itself records is {@link decided},
   * beside this — not the erasure of it.
   */
  review: PlanReviewDto | null;
  /**
   * The LIVE review of the plan being WRITTEN (Subtask MOTIR-6295) — a whole
   * snapshot of a `generating` plan, replaced on every tick of the shared
   * generating-plan poll (`useGeneratingPlanPoll`), never merged.
   *
   * Fed for the plan the session is writing, whoever writes it: the hosted run's
   * plan from the moment its turn is submitted, and a NAMED session's
   * `pendingPlanId` at mount when that plan is still `generating` (an MCP agent
   * writing it). {@link review} cannot carry this: `readPendingProposal` is null
   * for a `generating` plan by design.
   *
   * ⚠️ A HAND-OVER, NOT A SECOND REVIEW. When the poll OBSERVES the plan leave
   * `generating` — the transition, once — the existing proposed-review path
   * (`readPendingProposal` → {@link review}) runs exactly once and this goes back
   * to `null` — in the SAME update that sets `review`, so the planning surface's
   * pane, which draws `liveReview ?? review`, is never without a plan in between
   * and is not remounted (MOTIR-6300).
   */
  liveReview: PlanReviewDto | null;
  /** Bumped on every applied live snapshot. */
  liveVersion: number;
  /** The live poll has failed several reads in a row (the last snapshot stands). */
  liveFailing: boolean;
  /**
   * The plan this session WATCHED being written, when it ended DISCARDED rather
   * than proposed (MOTIR-6300; design Part XXIII §23.12): `generating → declined`
   * with `decisionReason: 'discarded'` — a plan closed holding zero proposals,
   * decided by nobody. `readPendingProposal` is null for it, so {@link review}
   * never carries it; this is the last snapshot, kept so the pane that drew the
   * plan live can say how it ended instead of vanishing. Only an OBSERVED
   * transition sets it, and a new run clears it.
   */
  discardedReview: PlanReviewDto | null;
  /**
   * WHICH WAY the current `review` was decided, or `null` while it is still
   * pending (MOTIR-3162). It is what tells the canvas to draw the accepted or
   * declined treatment `design/ai-planning/design-notes.md` Part VI specifies —
   * the SAME treatment the plan-detail canvas renders, one language across both
   * surfaces rather than a second one invented here.
   */
  decided: PlanItemOutcome | null;
  jobId: string | null;
  /**
   * The `Plan` the current run's proposals append into (MOTIR-1743/1745) — what a
   * confirm must address. Set from the submit response, and RE-ESTABLISHED on
   * mount from the resume when the thread left a proposal undecided, so a user
   * who closed the workspace mid-review comes back able to act on it. `null`
   * whenever there is nothing pending, and read defensively: an older response or
   * a stubbed one carries only `jobId`.
   */
  planId: string | null;
  /**
   * The plan job whose `target_settled` frame has arrived (MOTIR-8203) — the end
   * of the conversation phase (PART 1) and the start of the planning phase. Keyed
   * by JOB rather than a boolean so a new run is unsettled without every start
   * reducer having to reset it, and a question that ends a job in PART 1 never
   * settles it. Read through `planRunPhase` (`lib/planning/planRunPhase.ts`), never directly. Optional so a
   * state built by hand (every rail test) is an unsettled one.
   */
  settledJobId?: string | null;
  /** The last approve's result, so the rail can say what landed. */
  approved: PlanApproveSummary | null;
  /** A recoverable failure: `FAILED` / `EMPTY` / `immutable` / a typed code. */
  errorCode: string | null;
  /** The metered-AI refusal — a distinct state, not an error (design panel 6). */
  outOfCredits: boolean;
  /**
   * The user has asked for a stop and the walk has not reached its boundary yet
   * (Story MOTIR-4054 · MOTIR-4068).
   *
   * ⚠️ IT IS NOT A TERMINAL STATE, and keeping it separate from {@link stopped}
   * is the whole point. The click is not the stop: `runWalk` reads the flag at
   * its NEXT phase boundary, which can be a whole authoring session away, so
   * there is a real interval in which the run is still narrating and the user has
   * already asked it to end. A surface that collapses the two claims the run is
   * over while it is visibly still working, which is worse than a slow stop.
   */
  stopping: boolean;
  /**
   * What the user typed WHILE the run was working, and whether the run has read
   * it yet (Story MOTIR-4054 · MOTIR-4274).
   *
   * ⚠️ NOT PART OF THE THREAD, and that is the storage talking rather than a
   * choice. A mid-run turn goes into the boundary MAILBOX, which is a different
   * table from `plan_change_turn` — so it is not in `session.turns` and cannot be
   * rendered from there. It joins the transcript's history only if and when a
   * later run's accumulated intent carries it.
   *
   * `read` flips when the run has taken it at a phase boundary. Until then the
   * surface must say QUEUED: a message that looks delivered and changes nothing
   * for another thirty seconds reads as a bug, and the boundary can be a whole
   * authoring session away.
   */
  queued: QueuedTurn[];
  /**
   * A change the person typed mid-run that the answering session read as a CHANGE
   * but could not forward, because the run had ENDED (MOTIR-7996). The turn is
   * still on the thread; `text` is the words to hand back to the composer and
   * `code` is why (`PLAN_CHANGE_JOB_NOT_RUNNING`). The rail draws it and puts the
   * text back (the rail-rendering work item); this state only carries it. Null
   * otherwise, and cleared by the next mid-run send. OPTIONAL (absent reads as null)
   * so a state built by hand — every rail test — needs no change.
   */
  refusedForward?: { text: string; code: string } | null;
  /**
   * A change the person forwarded after the walk finished but before the plan was
   * decided, now applied as ONE revision of the plan (MOTIR-7997): `planId` is the
   * plan, `revisionJobId` the REVISE_PLAN job (on the plan's timeline), `count` the
   * forwarded changes it carries. Set by the late-changes call at the end of a run
   * and by the settle's `revised_late` outcome. The rail draws it (the rail-rendering
   * work item); this state only carries it. Null otherwise. OPTIONAL (absent reads as
   * null) so a state built by hand — every rail test — needs no change.
   */
  lateRevision?: {
    planId: string;
    revisionJobId: string;
    count: number;
    /** The mailbox entries the revision carried, when the end-of-run claim made it:
     *  the persisted turns are not marked `revisedLate` on that path, so the rail
     *  recognises the stranded turns by these ids. Absent on the settle path. */
    entryIds?: string[];
  } | null;
  /**
   * A QUESTION the person typed while a run works, whose answer is still being
   * written (MOTIR-7998). Set when the mid-run send starts and cleared when that
   * ask settles or fails; it never touches `jobId`, `phase`, `stopping` or the
   * run's abort controller. The rail draws the question and the answering cue from
   * it. OPTIONAL (absent reads as null) so a state built by hand needs no change.
   */
  midRunAsk?: { text: string } | null;
  /**
   * The planner's latest mid-run PAUSE on this run (MOTIR-8010), as the poll last
   * read it; absent until it has read one, when the session DTO's own `runPause`
   * stands in (`pauseOf`). An unanswered pause on the running job IS the paused
   * state. OPTIONAL (absent reads as unset) so a state built by hand needs no change.
   */
  runPause?: PlanChangeRunPauseDto | null;
  /** An answer to the pause is in flight — both controls read disabled. */
  answeringPause?: boolean;
  /** The pause's answer was REFUSED because the run ended first (MOTIR-8010): why,
   *  which choice, and the reply's text to hand back to the composer. */
  pauseAnswerRefusal?: {
    code: string;
    choice: 'start_over' | 'apply' | 'reply' | 'resume';
    text?: string;
  } | null;
  /**
   * The run ENDED because the user ended it.
   *
   * ⚠️ THIS IS NOT AN ERROR, and the code below goes out of its way not to record
   * one. A stopped run proposes nothing NEW at the moment it ends, which is
   * exactly the shape the settle path reads as `EMPTY` — so without this flag the
   * honest outcome of a deliberate act would surface as a failure the user has to
   * dismiss. `errorCode` stays null and `review` survives: what was proposed
   * before the stop is worth exactly what it was worth a second earlier.
   */
  stopped: boolean;
  /**
   * FRESH START pointer (MOTIR-6024; design §19.8): nothing resumed on open, and
   * the scope has an EARLIER conversation — the notice links to its Plans row.
   * Null once this conversation has a turn, and on a resumed or reopened one.
   */
  earlier: EarlierSessionDto | null;
  /**
   * REOPENED by id (a Plans row, `planSession=<id>`): who started it and when it
   * was last active, for the one line above the opener. Null otherwise.
   */
  reopened: {
    startedBy: { id: string; name: string } | null;
    mine: boolean;
    lastActivityAt: string;
  } | null;
  /** The reopened conversation is READ-ONLY for this viewer (no `ai:plan`): the
   *  composer is replaced by the reason. */
  readOnly: boolean;
  /**
   * When nothing resumed: the caller's own failed / idle-closed session of the
   * scope, whose conversation a new session may carry over (AMENDMENT 23 §6).
   * Optional so a state built by hand needs no change.
   */
  copyable?: CopyableSessionDto | null;
  /**
   * ANOTHER holder has one of this scope's cards (AMENDMENT 23 §4; MOTIR-7643) —
   * read on open, or carried by a send's `409 PLAN_TARGET_LOCKED`. The rail refuses
   * IN PLACE (a status, not an error) and the composer is disabled for the target;
   * nothing is sent. Optional so a state built by hand needs no change.
   */
  targetHeld?: PlanTargetHeldByDto | null;
  /**
   * The work item each ask turn SENT FROM HERE was anchored on, by user-turn id
   * (MOTIR-7050) — the report widget's triage bug on its seeded turn. The
   * rail draws it as the turn's target row. The send-time SEED only: the turn
   * DTO carries the persisted anchor (`anchorKey`, MOTIR-7064) and the rail reads
   * that first, so a reloaded thread keeps the chip; this covers a turn whose DTO
   * has not come back with one. Optional so a state built by hand (every rail
   * test) needs no change.
   */
  turnAnchors?: Readonly<Record<string, string>>;
  /**
   * THE PLANNER'S NARRATION (Story MOTIR-8060 · MOTIR-8064) — the stored read
   * (`PlanReviewDto.narration`) of the plan this surface last read, replaced WHOLE
   * on every review read the hook already makes (the generating-plan poll's
   * snapshots and the proposed / decided reads). Never merged with stream state:
   * it is what makes the chat panel's narration survive a reopen.
   */
  narration?: PlanNarrationReadDto | null;
  /** What rides beside {@link narration}: whose plan it is, which sessions are
   *  live on that snapshot, and the EARLIER sentence pages the panel fetched —
   *  kept by `seq`, dropped when the plan changes, never overwritten by a poll. */
  narrationKept?: PlanNarrationKept | null;
  /**
   * PLAN SOMETHING NEW confirmed here (MOTIR-7650; ADR AMENDMENT 3): the id of the
   * session that just ended `restarted`, for the rail's earlier-session line above
   * the new session's opener. Null otherwise, and cleared by the next swap.
   * Optional so a state built by hand needs no change.
   */
  restartedFrom?: string | null;
  /** A confirm or keep answer is IN FLIGHT — the confirm's two buttons and the
   *  control hold still until it lands. Optional for the same reason. */
  restarting?: boolean;
  /**
   * RESUME is IN FLIGHT for a failed-waiting session (Story MOTIR-7905 · MOTIR-7918) — Resume
   * reads *Resuming…* and is disabled until the new attempt's stream is attached (or the
   * refusal is back). Optional for the same reason as the fields above.
   */
  resuming?: boolean;
  /**
   * WHY the last Resume did not start — the refusal's stable code (`NOT_SESSION_OWNER`,
   * `SESSION_NOT_FAILED`, `PLAN_NOT_RESUMABLE`, `PLAN_SESSION_ENDED`, out-of-credits, …), or
   * `null`. The failure line stays; this adds the *could not start* words beside it.
   */
  resumeError?: string | null;
  /**
   * THE PLAN OFFER's answer is IN FLIGHT (Story MOTIR-9219 · MOTIR-9294): the offer
   * turn whose Confirm or Decline was pressed, until its door answers. Optional for
   * the same reason as the fields above.
   */
  offerAnsweringTurnId?: string | null;
  /** The last REFUSED offer answer — the offer's turn and the door's reason (or
   *  code). The row draws the refusal line in place of its actions. */
  offerRefusal?: { turnId: string; code: string } | null;
  /**
   * THE CARRY IS IN FLIGHT (Story MOTIR-7928 · MOTIR-7932; design state 3): the
   * owner wrote in an ENDED session whose plan still waits, and the turn that starts
   * the new session has not come back yet. The text is drawn pending under the end
   * marker and the composer is locked, so a second send cannot fire. Optional for
   * the same reason as the fields above.
   */
  carrying?: { text: string } | null;
  /** The ended session the plan on screen was just CARRIED out of (design state 4):
   *  the rail says "this plan moved here" under the copied divider. Null otherwise. */
  carriedFrom?: string | null;
  /** The carry was TAKEN BACK onto the person's open session (design state 5):
   *  the plan that still waits elsewhere, for the line that leads back to it. */
  takenBackWaitingPlanId?: string | null;
  /** The plan was DECIDED before the carry reached it (design state 6): the words
   *  that were not sent, kept so they can be copied. */
  carryDecided?: { text: string } | null;
  /**
   * A turn landed on a STALE plan (MOTIR-7945; design state 10): nothing was revised
   * or spent, and the answer is drawn under the turn as the stale notice — never as
   * an error. Drawn from the submit's answer, not from the session row: nothing is
   * written on the server, so a reload's next send gets the same answer again.
   */
  stalePlan?: StalePlanState | null;
}

/** What the stale notice draws (design state 10 and its variants). */
export interface PlanNarrationKept {
  planId: string;
  /** Session keys holding an in-flight step on a `generating` snapshot. */
  live: readonly string[];
  /** Sentences before the read's window, fetched by "N earlier notes". Once any
   *  are kept, each new read also keeps the window it replaces, so the kept run
   *  stays contiguous with the next window. */
  earlier: readonly PlanNarrationDto[];
  loadingEarlier: boolean;
}

/** The narration fields a review read sets on the state. */
function narrationFrom(
  s: PlanChangeConversationState,
  review: PlanReviewDto,
): Pick<PlanChangeConversationState, 'narration' | 'narrationKept'> {
  const kept = s.narrationKept?.planId === review.id ? s.narrationKept : null;
  const earlier =
    kept && kept.earlier.length > 0
      ? mergeNarrationEntries(kept.earlier, s.narration?.entries ?? [])
      : [];
  return {
    narration: review.narration ?? null,
    narrationKept: {
      planId: review.id,
      live: liveNarrationSessions(review),
      earlier,
      loadingEarlier: kept?.loadingEarlier ?? false,
    },
  };
}

const NO_NARRATION = { narration: null, narrationKept: null } as const;

export { GUIDE_OFFER_CLOSED };

export interface StalePlanState {
  planId: string;
  finishedCards: StalePlanFinishedCard[];
  /** The user turn this answers, when the thread holds it. */
  turnId: string | null;
  /** Plan it again is in flight — the action and the composer hold still. */
  pressing: boolean;
  /** How the press ended: a fresh plan (`accepted`), the plan was current again
   *  (`restored`), refused because it was decided (`refused`), or another press won
   *  (`superseded`). Every outcome withdraws the action; null keeps it offered. */
  outcome: 'accepted' | 'restored' | 'refused' | 'superseded' | null;
}

const INITIAL: PlanChangeConversationState = {
  phase: 'loading',
  session: null,
  progress: null,
  acts: [],
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  settledJobId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  refusedForward: null,
  lateRevision: null,
  earlier: null,
  reopened: null,
  readOnly: false,
  copyable: null,
  targetHeld: null,
  turnAnchors: {},
  ...NO_NARRATION,
};

const OUT_OF_CREDITS_CODES = new Set(['MOTIR_AI_OUT_OF_CREDITS', 'out_of_credits']);

/**
 * How often the composer asks whether its queued turns have been read
 * (MOTIR-4274). Three seconds: a phase boundary is minutes apart, so this is
 * about how quickly the surface stops saying QUEUED, not about catching the
 * boundary. It only ticks while a run is streaming AND something is unread.
 */

/**
 * How often an open surface re-reads a plan whose gate is AWAITING, so a revision
 * lease taken or released SOMEWHERE ELSE — a second tab, another member, an agent
 * revising over MCP — reaches its verbs (bug MOTIR-6151). It bounds how long the
 * surface can offer a press the door will refuse, and it is the refresh bound the
 * acceptance criterion names. A focus or a return to the tab re-reads at once.
 */
export const PLAN_GATE_POLL_MS = 3000;

/**
 * The FIRST act of a run — the rail's opening line and the live line, one
 * object (MOTIR-4069). `design/ai-chat/plan-change-run-live.mock.html` sheet 3
 * draws `submitted` and `reading` as act lines like any other, so a run's record
 * starts with the act that started it rather than with the first frame the
 * server happened to send.
 */
function firstAct(
  kind: 'submitted' | 'reading',
): Pick<PlanChangeConversationState, 'progress' | 'acts'> {
  const act: PlanChangeProgress = { kind };
  return { progress: act, acts: [act] };
}

/**
 * The act record with the ask's opening `reading` act taken out (bug MOTIR-7924).
 *
 * `reading` says "Reading your request…" — a sentence about something HAPPENING —
 * and the record outlives the run on purpose, so an ask that has ENDED (answered,
 * silent, failed or refused) must not keep it: a finished answer with that line
 * under it reads as still working. The acts that follow it stay, because they are
 * the record of what the run actually did; for a plain answer there are none.
 */
function withoutReading(acts: PlanChangeProgress[]): PlanChangeProgress[] {
  return acts.filter((act) => act.kind !== 'reading');
}

const STARTING_ACT: PlanChangeProgress = { kind: 'starting' };

/** The run with the starting-up act appended (MOTIR-9255), once. */
function withStarting(s: PlanChangeConversationState): PlanChangeConversationState {
  if (s.acts.some((act) => act.kind === 'starting')) return s;
  return { ...s, progress: STARTING_ACT, acts: [...s.acts, STARTING_ACT] };
}

/** The run with the starting-up act taken back down: it says something is
 *  HAPPENING, so it never outlives the submit that waited. */
function withoutStarting(s: PlanChangeConversationState): PlanChangeConversationState {
  if (!s.acts.some((act) => act.kind === 'starting')) return s;
  const acts = s.acts.filter((act) => act.kind !== 'starting');
  return {
    ...s,
    acts,
    progress: s.progress?.kind === 'starting' ? (acts.at(-1) ?? null) : s.progress,
  };
}

/** The statuses a planning job ENDS on — motir-ai's terminal set (MOTIR-7985). */
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'canceled']);

function frameField(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

/** Consecutive lost connections (no frame between them) the run tail rides out before it
 *  says the stream could not be reached — about two minutes of backoff (MOTIR-9186). */
const MAX_LOST_RESUBSCRIBES = 12;

/** Wait before subscribing again to a job whose stream closed while it still ran:
 *  1s, doubling, at most 15s — a connection that keeps dropping is not hammered.
 *  Resolves early on abort, and when the page comes back to the foreground or the
 *  network returns (MOTIR-9186) — the moment a locked screen unlocks is exactly
 *  when waiting out the backoff helps nobody. The caller checks `aborted` before
 *  it waits. */
function pauseBeforeResubscribe(attempt: number, signal: AbortSignal): Promise<void> {
  const ms = Math.min(1000 * 2 ** attempt, 15_000);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      if (typeof window !== 'undefined') window.removeEventListener('online', done);
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisible);
      resolve();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') done();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (typeof window !== 'undefined') window.addEventListener('online', done, { once: true });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  });
}

/** Map one raw SSE frame to the narration the rail shows, or null to ignore it. */
export function narrateFrame(event: string, data: unknown): PlanChangeProgress | null {
  const d = (data ?? {}) as Record<string, unknown>;

  // ⚠️ AN UNLISTED FRAME DRAWS NOTHING (MOTIR-8158). It used to surface on the
  // rail as `frame: <name>`, which meant nothing to the person. The developer
  // signal stays — a console warning naming the file to fix — and catching a new
  // kind is the job of `tests/planning/frameKindParity.test.ts`, not the screen.
  if (!isKnownFrameKind(event)) {
    console.warn(
      `[plan-change] unnarrated frame kind "${event}" — add it to PLAN_CHANGE_FRAME_KINDS ` +
        `and give it a disposition in lib/planning/planChangeFrames.ts`,
    );
    return null;
  }

  const disposition = FRAME_DISPOSITIONS[event];
  // QUIET is a DECISION, not a fall-through. The reason is on the map entry, and
  // this null is the one place a null is legitimate.
  if ('quiet' in disposition) return null;

  switch (disposition.show) {
    case 'laying': {
      const target = d['target'];
      return { kind: 'laying', target: typeof target === 'string' ? target : null };
    }
    case 'authoring': {
      const title = d['title'];
      return { kind: 'authoring', title: typeof title === 'string' ? title : null };
    }
    case 'note': {
      const text = d['text'];
      // Defensive on OUR side too: the producer already refuses to emit a blank
      // note ("a blank line is not a shorter line, it is a line the rail would
      // render as a hole"), and a hole is exactly what a bad payload would draw.
      const trimmed = typeof text === 'string' ? text.trim() : '';
      return trimmed.length === 0 ? null : { kind: 'note', text: trimmed };
    }
    case 'proposed': {
      const raw = d['proposed'];
      return { kind: 'proposed', count: typeof raw === 'number' ? raw : 0 };
    }
    case 'validating':
      return { kind: 'validating' };
    default:
      // Unreachable: `show` is a `PlanChangeProgress['kind']` and every one the
      // map uses is handled above. Kept so a new SHOW value is a visible gap
      // rather than a silent null — the same mistake, one level in.
      return null;
  }
}

/** The part of the state one planning frame can change. */
export type PlanFrameState = Pick<PlanChangeConversationState, 'progress' | 'acts'>;

/**
 * Apply one frame of a PLANNING run to the act record and the live line.
 *
 * {@link narrateFrame} is a pure one-frame → one-act function; a quiet frame (a
 * lookup, a tool call, a bookkeeping frame, an unlisted kind) yields null and
 * changes nothing. APPEND to the rail and REPLACE the live line, in one update.
 * Returns the SAME object when nothing changes.
 */
export function applyPlanFrame(
  state: PlanFrameState,
  event: string,
  data: unknown,
): PlanFrameState {
  const progress = narrateFrame(event, data);
  if (!progress) return state;
  return { progress, acts: [...state.acts, progress] };
}

export interface UsePlanChangeConversationOptions {
  /**
   * An approve COMMITTED work items — the caller routes the page-state fan-out
   * (`motir-core/CLAUDE.md`): the canvas is a client island seeded once, so it
   * needs an explicit refetch trigger, and the Workbench behind the workspace is
   * asked to re-read its own window. Nothing refreshes the route (MOTIR-8576).
   */
  onApproved?: (result: PlanApproveSummary) => void;
  /**
   * The work item this conversation is ANCHORED at, by database id (MOTIR-910's
   * per-item entrance). When set, every hop rides the item-scoped MOTIR-909
   * endpoints instead of the project-wide thread — a different CONVERSATION, not
   * a different mechanism: same substrate, same job kind, same approve route.
   * Absent (the launcher's project/roadmap contexts) → the shipped 7.30 thread.
   */
  anchorId?: string | null;
  /**
   * REOPEN this exact conversation (MOTIR-6024) — the overlay's `planSession`
   * address, which a Plans row writes. The resume read does not apply: a
   * named session opens whatever its age or starter.
   */
  sessionId?: string | null;
  /**
   * The named `sessionId` is a RESUME, not a reopen (MOTIR-6210; design MOTIR-6206
   * sheet 7): the refusal seed's `seededSessionId` names the viewer's OWN recent
   * seeded conversation, returned to within the window — MOTIR-6019's resumed
   * state. `reopened` stays `null`, so the rail claims no *Reopened from the
   * Plans page* line it would be lying about.
   */
  sessionIsResume?: boolean;
  /**
   * The overlay SWAPPED to a new session in place (MOTIR-7650) — the caller puts
   * its address where the old one's was. The hook already holds the session, so
   * the `sessionId` that comes back through the address re-opens nothing.
   */
  onRestarted?: (sessionId: string) => void;
  /**
   * The REFUSED gate a seeded re-plan starts from (story MOTIR-6068 · MOTIR-6210).
   * Two effects, both once-only:
   *  · the mount opens NOTHING — the caller's ordinary resumable conversation on
   *    the card is not the one a refusal starts, and the seeded turn is unsent,
   *    so the rail is empty until Send (design sheet 2);
   *  · the FIRST anchored send — the one with no session yet — carries it, so
   *    the session the server starts remembers the gate. Every later send has a
   *    session and carries nothing.
   */
  seedGateId?: string | null;
  /**
   * The GUIDE OFFER a seeded planning start comes from (Story MOTIR-8684 · MOTIR-8693).
   * It behaves as {@link seedGateId} does — the mount opens nothing, and the FIRST send
   * (the one with no session yet) carries it — and is never set beside it. Its three
   * refusals end the send without a retry:
   *  · `409 GUIDE_REPLAN_OFFER_CONFIRMED { sessionId }` — the offer already started a
   *    session; {@link UsePlanChangeConversationOptions.onGuideOfferConfirmed} is told
   *    which, and nothing more is sent;
   *  · `409 GUIDE_REPLAN_OFFER_NOT_OPEN` and `422 SEED_NOT_APPLICABLE` — the offer is
   *    closed: `errorCode` becomes {@link GUIDE_OFFER_CLOSED} and nothing is retried.
   */
  seedGuideTurnId?: string | null;
  /** The offer was already confirmed: the session id to return to. */
  onGuideOfferConfirmed?: (sessionId: string) => void;
}

/**
 * What one run is ANCHORED at: the primary anchor (the endpoint's path item) plus
 * the additional targets the `@`-mention picker added (MOTIR-1491). `null` is the
 * project-wide thread. Every hop of a run — submit, stream, resubmit — uses the
 * SAME anchor, because they all address one conversation.
 */
interface RunAnchor {
  anchorId: string;
  targetKeys: string[];
}

/** `run`'s own signature, so a helper defined before it can reach it through a ref. */
type RunFn = (
  anchor: RunAnchor | null,
  submitter?: (
    signal: AbortSignal,
  ) => Promise<{ jobId: string; planId?: string; session: PlanChangeSessionDto }>,
) => Promise<void>;

/** Whether the picker's target set names exactly the session's own targets. No set
 *  ("no opinion") matches, as it falls back to the entrance anchor everywhere else. */
function planningTargetsMatchSession(
  targets: readonly PlanningTarget[] | undefined,
  session: { targetKeys: readonly string[] } | null,
): boolean {
  if (targets === undefined || !session) return true;
  const norm = (keys: readonly string[]) =>
    keys
      .map((k) => k.toUpperCase())
      .sort()
      .join(',');
  return norm(targets.map((t) => t.identifier)) === norm(session.targetKeys);
}

/**
 * Which conversation a turn belongs to. The picker's SET wins when the caller
 * has one (an empty set is a real answer — the project thread); a caller that
 * passes nothing keeps the entrance's single anchor.
 */
function resolveAnchor(
  targets: readonly PlanningTarget[] | undefined,
  entranceAnchorId: string | null,
): RunAnchor | null {
  if (targets === undefined) {
    return entranceAnchorId ? { anchorId: entranceAnchorId, targetKeys: [] } : null;
  }
  const primary = primaryPlanningTarget(targets);
  return primary ? { anchorId: primary.id, targetKeys: extraPlanningTargetKeys(targets) } : null;
}

/**
 * Tell the page an ASKED plan's gate was decided here (MOTIR-6037), so its To-approve row
 * settles in place under the overlay rather than reading *Decided elsewhere* on the next
 * refresh (`lib/approvals/decidedGates.ts`). Only a plan the reader was shown AS a
 * question — an `awaiting` gate on the review in hand — announces anything.
 *
 * The row reads only the STATE, and the state is all this surface announces: the gate's
 * audit columns are the server's and never reached it, so no gate row is built here
 * (`announceGateStateDecided`) — `approval_gate.outcome_ref` keeps its one writer.
 */
function announcePlanGateDecided(
  review: PlanReviewDto | null,
  state: 'approved' | 'declined',
): void {
  const gate = review?.gate;
  if (!gate || gate.state !== 'awaiting') return;
  announceGateStateDecided(gate.id, state);
}

/** A send refused because another holder has the card (AMENDMENT 23 §4): the
 *  refusal's holder and free-by, from the `409 PLAN_TARGET_LOCKED` body. */
export function targetHeldFrom(err: unknown): PlanTargetHeldByDto | null {
  if (!(err instanceof PlanEditsClientError) || err.code !== 'PLAN_TARGET_LOCKED') return null;
  const body = (err.body ?? {}) as Partial<Record<string, unknown>>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    target: str(body.target) ?? '',
    holder: str(body.holder),
    freesBy: str(body.freesBy),
    holderSessionId: str(body.holderSessionId),
    // Absent ⇒ false, so an older server still words a free-by time (MOTIR-7918).
    sessionWaiting: body.sessionWaiting === true,
    waitingCause:
      body.waitingCause === 'question' ||
      body.waitingCause === 'reply' ||
      body.waitingCause === 'failed'
        ? body.waitingCause
        : null,
  };
}

/**
 * The two refusals of a TURN on a session that waits (Story MOTIR-7905 · MOTIR-7941) that the
 * rail words in place instead of as the generic failure: a revision already runs on the plan
 * (`PLAN_REVISION_IN_FLIGHT`), or the session holds a failed walk that only Resume continues
 * (`SESSION_AWAITING_RESUME`). Neither is retryable by pressing Try again, and the draft is kept.
 */
export function refusalCodeOf(
  err: unknown,
): 'PLAN_REVISION_IN_FLIGHT' | 'SESSION_AWAITING_RESUME' | null {
  if (!(err instanceof PlanEditsClientError)) return null;
  return err.code === 'PLAN_REVISION_IN_FLIGHT' || err.code === 'SESSION_AWAITING_RESUME'
    ? err.code
    : null;
}

/** The session a guide-seeded send was answered `409 GUIDE_REPLAN_OFFER_CONFIRMED` with
 *  (MOTIR-8693) — the offer already started it — or `null` for any other answer. */
export function guideOfferConfirmedSession(err: unknown): string | null {
  if (!(err instanceof PlanEditsClientError) || err.code !== 'GUIDE_REPLAN_OFFER_CONFIRMED') {
    return null;
  }
  const id = ((err.body ?? {}) as Partial<Record<string, unknown>>).sessionId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** `GUIDE_OFFER_CLOSED` for the two answers that end a guide-seeded send with its offer
 *  no longer open — declined or superseded, or a scope the offer does not fit — else null. */
export function guideOfferClosedCode(err: unknown): string | null {
  if (!(err instanceof PlanEditsClientError)) return null;
  return err.code === 'GUIDE_REPLAN_OFFER_NOT_OPEN' || err.code === 'SEED_NOT_APPLICABLE'
    ? GUIDE_OFFER_CLOSED
    : null;
}

/** Whether a thread has ENDED (AMENDMENT 23 §1) — read from the server's row. */
/** The code a refused plan-offer answer is drawn from (MOTIR-9294): out of credits,
 *  else the refused start's `reason`, else the door's code. */
export function offerRefusalCodeOf(err: unknown): string {
  if (!(err instanceof PlanEditsClientError)) return 'FAILED';
  if (err.isOutOfCredits) return 'MOTIR_AI_OUT_OF_CREDITS';
  const reason = (err.body as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' ? reason : (err.code ?? 'FAILED');
}

export function sessionEnded(session: PlanChangeSessionDto | null | undefined): boolean {
  return Boolean(session?.endedAt);
}

/**
 * Whether an OPEN thread is waiting on a failed attempt (Story MOTIR-7905 · MOTIR-7918) — read
 * from the server's row, never inferred from a stream error, so a reload shows the same thing.
 * An ended session is never failed-waiting: its end marker is the state.
 */
export function sessionFailed(session: PlanChangeSessionDto | null | undefined): boolean {
  return Boolean(session?.failure) && !sessionEnded(session);
}

/** A failed-waiting thread whose way on is **Resume** — it holds a half-written walk. A failed
 *  session whose plan waits for the person (situation 2) is continued by the next turn, so it
 *  is NOT this: `failure.resumable` is absent ⇒ true. */
export function sessionAwaitsResume(session: PlanChangeSessionDto | null | undefined): boolean {
  return sessionFailed(session) && session?.failure?.resumable !== false;
}

/** How long the overlay waits between re-reads of a session a failed attempt may
 *  have ended — the relay ends it as it sees the terminal frame, which can land a
 *  moment after the browser's own stream reports the failure. */
export const SESSION_END_REREAD_MS = 400;
const SESSION_END_REREADS = 3;

/**
 * A review read filed into the one held, MERGED by identity when it is the same
 * plan (Story MOTIR-8539 · MOTIR-8575): an unchanged proposal keeps its object, and
 * a read that changed nothing keeps the held review itself. A different plan is
 * taken whole.
 */
export function fileReview(held: PlanReviewDto | null, next: PlanReviewDto): PlanReviewDto {
  return held && held.id === next.id ? mergePlanReview(held, next).review : next;
}

export function usePlanChangeConversation({
  onApproved,
  anchorId = null,
  sessionId = null,
  sessionIsResume = false,
  seedGateId = null,
  seedGuideTurnId = null,
  onGuideOfferConfirmed,
  onRestarted,
}: UsePlanChangeConversationOptions = {}) {
  const [state, setState] = useState<PlanChangeConversationState>(INITIAL);
  // The seed the FIRST send carries (MOTIR-6210). Seeded once from the option —
  // the host is keyed on its anchor, so it is fixed per mounted workspace — and
  // DROPPED when the server answers `SEED_NOT_APPLICABLE`: that refusal is
  // deterministic, so re-sending the same seed could only fail the same way, and
  // the person's words should still be sendable as an ordinary re-plan.
  const seedRef = useRef(seedGateId);
  // The guide offer the first send carries (MOTIR-8693). Spent by ANY answer from the
  // server — a refusal is deterministic, so the same seed could only fail the same way.
  const guideSeedRef = useRef(seedGuideTurnId);
  const guideConfirmedCbRef = useRef(onGuideOfferConfirmed);
  // A guide-seeded send is in flight (or just refused): only then does `SEED_NOT_APPLICABLE`
  // mean *this offer is closed*; for a gate seed it stays the generic failure.
  const guideSendRef = useRef(false);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // The entrance's anchor, read by callbacks that must not be re-created when it
  // changes (it is fixed per mounted workspace — the route's `?item=`).
  const anchorRef = useRef(anchorId);
  // What the LAST run was anchored at, so a retry resubmits to the same thread —
  // which, once the picker is in play, may be a different set than the entrance's.
  const lastAnchorRef = useRef<RunAnchor | null>(null);
  /** The `user` turn the last ASK run was for. A retry on the project thread
   *  re-runs THAT turn (no second user turn — ADR §3), and the correction
   *  affordance flips it. Null whenever the last run was a plan-change one. */
  const lastAskTurnRef = useRef<string | null>(null);
  /** The anchor that ask run was SENT with (MOTIR-7050), so its retry re-sends
   *  it: a debug turn's re-run must diagnose the same triage bug, not file a new
   *  one. Null for an unanchored turn, and whenever `lastAskTurnRef` is. */
  const lastAskAnchorRef = useRef<string | null>(null);
  /**
   * A stop is IN FLIGHT — the re-entry guard for {@link stop} (MOTIR-4068).
   *
   * ⚠️ A REF, NOT `state.stopping`, and the difference is the whole guard.
   * `stateRef` is written in an EFFECT (see its own comment below), so two clicks
   * in the SAME tick — which is exactly what a double-click is — both read the
   * pre-click value and both raise. This is set synchronously, inside the call,
   * before anything awaits, which is the shape `abortRef` already uses to keep a
   * second Enter from firing a second turn.
   */
  const stoppingRef = useRef(false);
  /**
   * A stop pressed before this run had a job the stop door can address (bug
   * MOTIR-7924) — during a submit whose job id has not come back yet, or while an
   * ASK or DEBUG job streams, which the door does not stop (it matches only the
   * session's plan job). It is HELD, not dropped: the branch that adopts the plan
   * job raises it there, and a run that ends without one clears it.
   */
  const pendingStopRef = useRef(false);
  /** The ask / debug job streaming right now — a job id {@link stop} must not
   *  post, because the stop door refuses it (MOTIR-7924). */
  const unstoppableJobRef = useRef<string | null>(null);
  /** The session a restart swapped in (MOTIR-7650), so the address naming it
   *  afterwards is recognised as already open. */
  const adoptedSessionRef = useRef<string | null>(null);
  /** A restart answer is in flight — set before the await, as `stoppingRef` is. */
  const restartingRef = useRef(false);
  /** Plan it again is in flight (MOTIR-7932) — set before the await, so a double
   *  press finds it set and a refusal knows it answers the press. */
  const planAgainRef = useRef(false);
  /** A plan offer's answer is in flight (MOTIR-9294) — set before the await, so a
   *  double press finds it set. */
  const offerAnsweringRef = useRef(false);
  const restartedCbRef = useRef(onRestarted);
  // A read-only mirror of the latest state, so a callback can read `jobId`/`planId`
  // without listing them as dependencies (which would re-create the callback — and
  // the rail's handlers — on every stream tick).
  const stateRef = useRef(state);
  // The latest `onApproved` without re-creating `approve` on every parent render.
  const approvedCbRef = useRef(onApproved);
  // Both mirrors are written in an EFFECT (never during render): the callbacks that
  // read them only run from a user event or after an await, by which point effects
  // have flushed.
  useEffect(() => {
    stateRef.current = state;
    approvedCbRef.current = onApproved;
    restartedCbRef.current = onRestarted;
    guideConfirmedCbRef.current = onGuideOfferConfirmed;
    anchorRef.current = anchorId;
  });

  // The side ASKS a mid-run turn opens (MOTIR-7996), each on its OWN controller so
  // the planning run's `abortRef` — and its Stop — are never touched by one.
  const midRunAbortsRef = useRef<Set<AbortController>>(new Set());

  // The planner's mid-run PAUSE (MOTIR-8010): polled while a run streams, and
  // answered by the offer's controls or by the composer's next turn.
  const { answerRunPause } = useRunPause({ state, stateRef, setState, mountedRef });

  useEffect(() => {
    mountedRef.current = true;
    const live = new AbortController();
    liveAbortRef.current = live;
    const midRunAborts = midRunAbortsRef.current;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      live.abort();
      for (const c of midRunAborts) c.abort();
      midRunAborts.clear();
    };
  }, []);

  // ── THE LIVE REVIEW (Subtask MOTIR-6295) ─────────────────────────────────
  // The plan being written right now, if any: the hosted run's (set when its turn
  // is submitted, cleared when the run ends) or a named session's pending one
  // (set at mount when it is still `generating`).
  const [livePlanId, setLivePlanId] = useState<string | null>(null);
  // The plan the poll has SEEN generating — what makes a later non-`generating`
  // snapshot a TRANSITION rather than merely a state.
  const sawGeneratingRef = useRef<string | null>(null);
  // The plan a NAMED session's open is still waiting on (bug MOTIR-6346): its
  // pending read was null, so the pane has nothing to draw until the poll's FIRST
  // read settles — and until then the phase stays `loading`, the skeleton.
  const openingLiveRef = useRef<string | null>(null);
  // The ONE proposed-review read per run: the hand-over and the settle of a hosted
  // run both reach for it, and whichever comes second awaits the first's read.
  const proposalReadRef = useRef<{
    planId: string;
    read: Promise<PlanReviewDto | null>;
  } | null>(null);
  const liveAbortRef = useRef<AbortController | null>(null);

  const readProposalOnce = useCallback((planId: string, signal?: AbortSignal) => {
    const memo = proposalReadRef.current;
    if (memo && memo.planId === planId) return memo.read;
    const read = readPendingProposal(planId, signal);
    proposalReadRef.current = { planId, read };
    return read;
  }, []);

  /** A new run: its plan has not been seen generating, nor its proposal read. */
  const resetLiveRun = useCallback(() => {
    sawGeneratingRef.current = null;
    proposalReadRef.current = null;
    openingLiveRef.current = null;
  }, []);

  /** Settle a named session's open on the poll's first answer about `planId`:
   *  `true` once, when that answer is the one the open was waiting on. The caller
   *  ends `loading` in the SAME update as whatever the answer brought, so no pane
   *  is drawn in between. */
  const settlesOpen = (planId: string) => {
    if (openingLiveRef.current !== planId) return false;
    openingLiveRef.current = null;
    return true;
  };
  const endOpening = (s: PlanChangeConversationState, settles: boolean) =>
    settles && s.phase === 'loading' ? { phase: 'idle' as const } : {};

  /** The run that watched `planId` has ended: its settle has filed what it
   *  proposed, so stop watching — a plan a failed run left `generating` must not
   *  be polled forever. */
  const endLive = useCallback((planId: string | null) => {
    if (planId) setLivePlanId((cur) => (cur === planId ? null : cur));
  }, []);

  /** The plan left `generating`: the existing proposed-review path takes over,
   *  once, and the live review is done. */
  const handOver = async (planId: string) => {
    let pending: PlanReviewDto | null = null;
    try {
      pending = await readProposalOnce(planId, liveAbortRef.current?.signal);
    } catch {
      /* nothing proposed we can show — the live review still ends */
    }
    if (!mountedRef.current) return;
    setState((s) => ({
      ...s,
      liveReview: null,
      // Exactly what the mount path does with a pending proposal; a run still
      // streaming keeps its phase, and its own settle re-enters the gate.
      ...(pending
        ? { review: fileReview(s.review, pending), phase: s.phase === 'idle' ? 'review' : s.phase }
        : {}),
    }));
  };

  const { failing: liveFailing, review: polledReview } = useGeneratingPlanPoll(livePlanId, {
    // The snapshot arrives MERGED (MOTIR-8575): a proposal that did not change keeps
    // its object, and the live pane's version moves only when the proposals did.
    onSnapshot: (snap, change) => {
      if (!livePlanId || !mountedRef.current) return;
      // A named session's open ends HERE, in the same update as this snapshot:
      // the skeleton hands straight to the live pane (or to the no-plan state).
      const settles = settlesOpen(livePlanId);
      if (snap.status === 'generating') {
        sawGeneratingRef.current = livePlanId;
        setState((s) => ({
          ...s,
          ...endOpening(s, settles),
          liveReview: snap,
          liveVersion: change.itemsChanged ? s.liveVersion + 1 : s.liveVersion,
        }));
        return;
      }
      // Out of `generating` — the poll has stopped itself. Only an OBSERVED
      // change hands over: a plan first read already settled is the mount's or
      // the run's own read to file, not this one's.
      const transitioned = sawGeneratingRef.current === livePlanId;
      sawGeneratingRef.current = null;
      if (!transitioned) {
        if (settles) setState((s) => ({ ...s, ...endOpening(s, true) }));
        return;
      }
      // DISCARDED while it was being written (§23.12): nothing is proposed, so there
      // is nothing to hand over — the ended snapshot replaces the live one in ONE
      // update, so the pane that drew it stays mounted and says how it ended.
      if (snap.status === 'declined' && snap.decisionReason === 'discarded') {
        setState((s) => ({ ...s, liveReview: null, discardedReview: snap }));
        return;
      }
      void handOver(livePlanId);
    },
  });

  // A named session's open whose poll cannot read the plan (MOTIR-6346): once the
  // poll says it is FAILING the skeleton gives way to the no-plan state rather than
  // standing for ever. The poll keeps retrying, and a later snapshot still brings
  // the live pane in over it.
  useEffect(() => {
    if (!liveFailing || !livePlanId || !settlesOpen(livePlanId)) return;
    setState((s) => ({ ...s, ...endOpening(s, true) }));
  }, [liveFailing, livePlanId]);

  // THE NARRATION (MOTIR-8064) follows every review read this hook already makes:
  // each poll snapshot (a decided plan's one read included, which `review` never
  // carries) and every proposed / decided read that lands in `review` or
  // `discardedReview`. No new request — the narration rides those reads, and
  // each one replaces it whole.
  useEffect(() => {
    if (polledReview) setState((s) => ({ ...s, ...narrationFrom(s, polledReview) }));
  }, [polledReview]);

  // A REOPENED RUN SETTLES FROM ITS STORED FRAMES (MOTIR-8203). A viewer who
  // comes back to a plan Motir is still writing did not see `target_settled`
  // arrive, so the run is subscribed once more — the relay replays a job from its
  // first frame — and read only for that frame. It closes the moment it has it,
  // and the whole time it is open nothing else is narrated from it: the live pane
  // and the stored narration already draw the run. Best-effort: a stream that
  // cannot be opened leaves the run in its conversation phase.
  const unsettledReopenedJob = (() => {
    const job = reopenedPlanJobId(state);
    return job !== undefined && job !== (state.settledJobId ?? null) ? job : null;
  })();
  useEffect(() => {
    if (!unsettledReopenedJob) return;
    const controller = new AbortController();
    void streamAugmentJob(
      unsettledReopenedJob,
      controller.signal,
      () => {},
      () => {},
      (event) => {
        if (event !== 'target_settled' || controller.signal.aborted) return;
        controller.abort();
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, settledJobId: unsettledReopenedJob }));
      },
    );
    return () => controller.abort();
  }, [unsettledReopenedJob]);
  const heldReview = state.review;
  useEffect(() => {
    if (heldReview) setState((s) => ({ ...s, ...narrationFrom(s, heldReview) }));
  }, [heldReview]);
  const endedReview = state.discardedReview;
  useEffect(() => {
    if (endedReview) setState((s) => ({ ...s, ...narrationFrom(s, endedReview) }));
  }, [endedReview]);

  /** "N earlier notes" (MOTIR-8064): page the sentences before the earliest in
   *  hand into the kept run. Best-effort — a failed read leaves the panel as is. */
  const showEarlierNarration = useCallback(async () => {
    const { narration, narrationKept } = stateRef.current;
    if (!narration || !narrationKept || narrationKept.loadingEarlier) return;
    const inHand = mergeNarrationEntries(narrationKept.earlier, narration.entries);
    if (narrationEarlierCount(inHand) === 0) return;
    const planId = narrationKept.planId;
    const setLoading = (loadingEarlier: boolean) =>
      setState((s) =>
        s.narrationKept?.planId === planId
          ? { ...s, narrationKept: { ...s.narrationKept, loadingEarlier } }
          : s,
      );
    setLoading(true);
    try {
      const page = await fetchPlanNarrationPage(planId, inHand[0]!.seq);
      if (!mountedRef.current) return;
      setState((s) => {
        const kept = s.narrationKept;
        if (kept?.planId !== planId) return s;
        const earlier = mergeNarrationEntries(
          page.entries,
          kept.earlier,
          s.narration?.entries ?? [],
        );
        return { ...s, narrationKept: { ...kept, earlier, loadingEarlier: false } };
      });
    } catch {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Open OR RESUME the thread on mount — the project's, or the ANCHORED item's.
  // Best-effort: a failure leaves an empty thread with a recoverable error, never
  // a broken rail. An anchored item that was never planned simply has no thread
  // yet (`null`), which is an empty rail, not an error.
  useEffect(() => {
    // The address now names the session a restart already swapped in (MOTIR-7650):
    // it is on screen, so there is nothing to open.
    if (sessionId && sessionId === adoptedSessionRef.current) return;
    // …or names the session a START turn just created (MOTIR-7973): the host
    // rewrites `planStart` to `planSession=<id>` once the first turn lands, and the
    // thread it names is the one already on screen, mid-run.
    if (sessionId && sessionId === stateRef.current.session?.id) return;
    // Any other address opens as it always did, and the adoption is spent: coming
    // BACK to the restarted session's address later must open it again.
    adoptedSessionRef.current = null;
    const controller = new AbortController();
    void (async () => {
      try {
        // Three opens (AMENDMENT 17 §1, §3; MOTIR-6024), none of which writes:
        //  · a NAMED session (`planSession=`, a Plans row) reopens that one,
        //    whatever its age — with who started it and whether it is read-only;
        //  · otherwise the caller's RESUMABLE session for the scope (anchored or
        //    project-wide), with its still-undecided plan;
        //  · otherwise NOTHING: an empty rail, and the scope's earlier
        //    conversation for the notice. The first turn starts the session.
        const opened = sessionId
          ? await getPlanChangeSession(sessionId, controller.signal).then((named) => ({
              session: named,
              planId: named.pendingPlanId ?? null,
              earlier: null,
              // A seed's return is a RESUME (MOTIR-6210): no reopened line.
              reopened: sessionIsResume
                ? null
                : {
                    startedBy: named.startedBy ?? null,
                    mine: named.startedByViewer === true,
                    lastActivityAt: named.lastActivityAt,
                  },
              readOnly: named.viewerCanPlan === false,
              copyable: null,
              targetHeld: null,
            }))
          : seedGateId || seedGuideTurnId
            ? // A SEEDED re-plan opens EMPTY (MOTIR-6210): the first turn sits
              // unsent in the composer, and no resumable conversation is read —
              // the seeded send starts its own session, or returns to one of the
              // same seed, server-side.
              {
                session: null,
                planId: null,
                earlier: null,
                reopened: null,
                readOnly: false,
                copyable: null,
                targetHeld: null,
              }
            : anchorId
              ? // Mount-time resume is the ENTRANCE's single anchor: the picker's set
                // is seeded from that same item. A target the user adds later is a
                // differently-scoped thread: the server sets the held session aside
                // and answers with the one for the new scope (MOTIR-8983).
                await resumeContextualSession(anchorId, [], controller.signal).then((r) => ({
                  session: r.session,
                  planId: r.planId ?? null,
                  earlier: r.earlier ?? null,
                  reopened: null,
                  readOnly: false,
                  copyable: r.copyable ?? null,
                  // Another holder has the card (AMENDMENT 23 §4): refused on OPEN,
                  // before the person types anything.
                  targetHeld: r.heldBy ?? null,
                }))
              : await findResumableSession(controller.signal).then((r) => ({
                  session: r.session,
                  planId: null,
                  earlier: r.earlier,
                  reopened: null,
                  readOnly: false,
                  copyable: r.copyable ?? null,
                  targetHeld: null,
                }));
        const { session, planId } = opened;
        if (!mountedRef.current) return;
        setState((s) => ({
          ...s,
          // ⚠️ STILL `loading` while a pending plan is left to read (bug MOTIR-6289).
          // The surface draws the roadmap for every null `review`, so an `idle` here
          // flashed the roadmap and then jumped to the plan the reader came to decide.
          // The read below settles it either way — `review`, or `idle` with nothing.
          phase: planId ? 'loading' : 'idle',
          session,
          planId: planId ?? null,
          earlier: opened.earlier,
          reopened: opened.reopened,
          readOnly: opened.readOnly,
          copyable: opened.copyable,
          targetHeld: opened.targetHeld,
        }));

        // A thread that left a proposal UNDECIDED comes back reviewable: read its
        // Plan and re-enter the gate, so closing the workspace mid-review is not
        // the same as discarding. Its own try: a plan that can't be read is a
        // usable thread with nothing pending, NOT an unavailable session.
        if (!planId) return;
        try {
          const pending = await readPendingProposal(planId, controller.signal);
          if (!mountedRef.current) return;
          // Nothing reviewable YET on a named session's plan may mean an agent is
          // still writing it (MOTIR-6295): watch it live. The poll's first read
          // says whether it is `generating`; one that is not stops at once.
          //
          // ⚠️ AND UNTIL THAT FIRST READ SETTLES, THE PHASE STAYS `loading` (bug
          // MOTIR-6346). A null here is exactly the MOTIR-6289 interval one read
          // later: an `idle` now would draw the roadmap, and the live pane would
          // swap in over it when the poll answered. The poll's first applied
          // snapshot ends it (`settlesOpen`), and so does the poll reporting
          // `failing`, so a plan that cannot be read never holds the skeleton.
          if (!pending) {
            if (sessionId) {
              openingLiveRef.current = planId;
              setLivePlanId(planId);
            } else {
              setState((s) => ({ ...s, phase: 'idle' }));
            }
            return;
          }
          setState((s) => ({ ...s, phase: 'review', review: fileReview(s.review, pending) }));
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          if (!mountedRef.current) return;
          // Nothing pending we can show — the conversation still works.
          setState((s) => ({ ...s, phase: 'idle' }));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, phase: 'idle', errorCode: 'SESSION_UNAVAILABLE' }));
      }
    })();
    return () => controller.abort();
  }, [anchorId, sessionId, sessionIsResume, seedGateId, seedGuideTurnId]);

  /**
   * STREAM a plan-edit job to its end, then file what it proposed — the tail of
   * every plan-change run.
   *
   * It is a named helper rather than the inline block it used to be because a
   * REDIRECTED ask hands off to exactly this (`docs/decisions/conversation-turn-intent.md`
   * Consequence 3): the ask job settles saying the turn was a plan change, and
   * from that moment the run must be indistinguishable from one the plan-change
   * door submitted. Re-implementing the tail beside the ask path would be two
   * settle behaviours for one outcome, and they would drift.
   */
  /**
   * A failed attempt may have ENDED the session (AMENDMENT 23 §2; MOTIR-7643) —
   * re-read it from the server, a few times, since the relay ends it as it sees
   * the terminal frame. An ended session replaces the thread in state, which is
   * what draws the end marker and takes away the retry; an open one is left as it
   * is, and its error stays recoverable in place. State from the SERVER, never
   * inferred from the stream error, so a reload shows exactly the same end.
   */
  const settleEnd = useCallback(
    async (signal: AbortSignal, failedJobId?: string): Promise<PlanChangeSessionDto | null> => {
      const id = stateRef.current.session?.id;
      if (!id) return null;
      for (let attempt = 0; attempt < SESSION_END_REREADS; attempt += 1) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, SESSION_END_REREAD_MS));
        let read: PlanChangeSessionDto;
        try {
          read = await getPlanChangeSession(id, signal);
        } catch {
          return null;
        }
        if (!mountedRef.current) return null;
        // …or left it WAITING on a failure (Story MOTIR-7905 · MOTIR-7918): the relay records the
        // failure on the still-open session, so the row is adopted exactly as an end is, and the
        // rail draws the failure line with Resume in place of the generic retryable error.
        if (sessionEnded(read) || sessionFailed(read)) {
          setState((s) => (s.session?.id === id ? { ...s, session: read } : s));
          return null;
        }
        // …or RESUMED it by itself (Story MOTIR-8301 · bug MOTIR-8336): a lost machine's relay
        // starts the automatic resume before the stream closes, so the session is open, carries
        // no failure, and names a NEW job. The caller attaches to it — its stream is what relays
        // the next loss, and its plan reads *resuming* until that job writes.
        if (failedJobId && read.lastJobId && read.lastJobId !== failedJobId) return read;
      }
      return null;
    },
    [],
  );

  /**
   * RAISE the stop on `jobId` (MOTIR-4068) — the one place the stop door is
   * called, shared by {@link stop} and by the branches that adopt a plan job a
   * stop was already waiting for (MOTIR-7924). A failed raise is said honestly:
   * the run is NOT stopping, so the bar must not keep claiming it is.
   */
  const raiseStop = useCallback(async (sessionId: string, jobId: string) => {
    try {
      await stopPlanChangeRun(sessionId, jobId, `stop:${jobId}`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!mountedRef.current) return;
      // The RAISE failed — the run is NOT stopping, and saying so is the honest
      // answer. Leaving the bar in its stopping state would tell the user their
      // click landed when it did not, and they would wait instead of clicking
      // again. The run itself is untouched, so nothing else changes.
      stoppingRef.current = false;
      setState((s) => ({ ...s, stopping: false }));
    }
  }, []);

  /**
   * A PLAN job is being adopted: hand it the stop that was waiting for one, if
   * any (MOTIR-7924). Answers whether a stop was carried, so the adopting reducer
   * keeps `stopping` set instead of resetting it — the reset is what used to drop
   * a Stop pressed during the correction's submit.
   */
  const takePendingStop = useCallback(() => {
    const carried = pendingStopRef.current;
    pendingStopRef.current = false;
    unstoppableJobRef.current = null;
    return carried;
  }, []);

  /** A run ENDED without ever adopting a plan job: a stop still waiting for one
   *  has nothing left to stop, so the bar stops saying "stopping". */
  const releasePendingStop = useCallback(() => {
    unstoppableJobRef.current = null;
    if (!pendingStopRef.current) return;
    pendingStopRef.current = false;
    stoppingRef.current = false;
    if (mountedRef.current) setState((s) => ({ ...s, stopping: false }));
  }, []);

  /** What a refused SUBMIT means for the rail: another holder's card (refused in
   *  place, AMENDMENT 23 §4), a session that has ended under it (re-read it), or a
   *  recoverable failure. */
  /**
   * FOLLOW the plan the server says is current (MOTIR-7932): Plan it again lost to
   * another press, or a newer plan already exists. Re-read the thread, then put that
   * plan on the canvas — its proposal when one is readable, else watch it being
   * written. Best-effort: a failed read leaves the screen as it is.
   */
  const followPlan = useCallback(async (latestPlanId: string | null, signal: AbortSignal) => {
    const id = stateRef.current.session?.id;
    if (!id) return;
    let read: PlanChangeSessionDto | null = null;
    try {
      read = await getPlanChangeSession(id, signal);
    } catch {
      /* keep the thread in hand */
    }
    if (!mountedRef.current) return;
    const planId = latestPlanId ?? read?.pendingPlanId ?? null;
    setState((s) => ({ ...s, ...(read ? { session: read } : {}), ...(planId ? { planId } : {}) }));
    if (!planId) return;
    let pending: PlanReviewDto | null = null;
    try {
      pending = await readPendingProposal(planId, signal);
    } catch {
      /* nothing proposed we can show */
    }
    if (!mountedRef.current) return;
    if (pending) {
      setState((s) => ({
        ...s,
        review: fileReview(s.review, pending),
        decided: null,
        phase: 'review',
      }));
    } else {
      setLivePlanId(planId);
    }
  }, []);

  /**
   * The answer to a turn over a STALE plan (MOTIR-7945; design state 10): the turn
   * is KEPT — the server appended it before the submit refused — so the thread is
   * re-read to show it, and the notice is drawn under it. No error, no code.
   */
  const adoptStalePlan = useCallback(
    async (err: PlanSessionPlanStaleClientError, signal: AbortSignal) => {
      const id = stateRef.current.session?.id;
      let read: PlanChangeSessionDto | null = null;
      if (id) {
        try {
          read = await getPlanChangeSession(id, signal);
        } catch {
          /* the thread in hand still answers */
        }
      }
      if (!mountedRef.current) return;
      setState((s) => {
        const session = read ?? s.session;
        const lastUser = [...(session?.turns ?? [])].reverse().find((t) => t.role === 'user');
        return {
          ...s,
          ...(read ? { session: read } : {}),
          stalePlan: {
            planId: err.planId,
            finishedCards: err.finishedCards,
            turnId: lastUser?.id ?? null,
            pressing: false,
            outcome: null,
          },
        };
      });
    },
    [],
  );

  /** Await a turn's submit, saying "starting up" while it waits long on a waking
   *  Motir AI (MOTIR-9255). No error is drawn while the server's budget lasts. */
  const awaitSubmit = useCallback(
    <T>(pending: Promise<T>): Promise<T> =>
      whileStartingUp(
        pending,
        () => {
          if (mountedRef.current) setState(withStarting);
        },
        () => {
          if (mountedRef.current) setState(withoutStarting);
        },
      ),
    [],
  );

  const refuseRun = useCallback(
    (err: unknown, controller: AbortController) => {
      // THE STALE OUTCOME and Plan it again's two refusals (MOTIR-7932) are answers
      // to FOLLOW, never errors: none of them shows a code or a retry.
      if (err instanceof PlanSessionPlanStaleClientError) {
        setState((s) => ({
          ...s,
          phase: s.review ? 'review' : 'idle',
          progress: null,
          acts: [],
          errorCode: null,
          outOfCredits: false,
        }));
        void adoptStalePlan(err, controller.signal);
        return;
      }
      const pressing = planAgainRef.current;
      if (pressing && err instanceof PlanAgainNotAvailableClientError) {
        setState((s) => ({
          ...s,
          phase: s.review ? 'review' : 'idle',
          progress: null,
          acts: [],
          errorCode: null,
          stalePlan: s.stalePlan
            ? { ...s.stalePlan, pressing: false, outcome: 'superseded' }
            : null,
        }));
        void followPlan(err.latestPlanId, controller.signal);
        return;
      }
      if (pressing && err instanceof PlanSessionPlanDecidedClientError) {
        setState((s) => ({
          ...s,
          phase: s.review ? 'review' : 'idle',
          progress: null,
          acts: [],
          errorCode: null,
          stalePlan: s.stalePlan ? { ...s.stalePlan, pressing: false, outcome: 'refused' } : null,
        }));
        void followPlan(null, controller.signal);
        return;
      }
      const guideSent = guideSendRef.current;
      guideSendRef.current = false;
      const confirmedSession = guideOfferConfirmedSession(err);
      if (confirmedSession !== null) {
        // The offer already started a session: nothing more is sent, no error is
        // drawn, and the overlay returns to that session (MOTIR-8693).
        setState((s) => ({
          ...s,
          phase: s.review ? 'review' : 'idle',
          progress: null,
          acts: withoutReading(s.acts),
          errorCode: null,
          outOfCredits: false,
        }));
        guideConfirmedCbRef.current?.(confirmedSession);
        return;
      }
      const gated = err instanceof PlanEditsClientError && err.isOutOfCredits;
      const held = targetHeldFrom(err);
      setState((s) => ({
        ...s,
        phase: s.review ? 'review' : 'idle',
        progress: null,
        // A refused correction must not leave its `reading` line behind (MOTIR-7924).
        acts: withoutReading(s.acts),
        errorCode:
          gated || held
            ? null
            : ((guideSent ? guideOfferClosedCode(err) : null) ??
              refusalCodeOf(err) ??
              unavailableCodeOf(err) ??
              'FAILED'),
        outOfCredits: gated,
        ...(held ? { targetHeld: held } : {}),
      }));
      if (err instanceof PlanEditsClientError && err.code === 'PLAN_SESSION_ENDED') {
        void settleEnd(controller.signal);
      }
      // A refused press keeps the action offered, so the person can press again.
      setState((s) =>
        s.stalePlan?.pressing ? { ...s, stalePlan: { ...s.stalePlan, pressing: false } } : s,
      );
    },
    [settleEnd, adoptStalePlan, followPlan],
  );

  /**
   * The late-change claim (MOTIR-7997), made ONCE when a planning run's stream
   * ends. It fires only when the mailbox state this hook already holds still lists
   * a forwarded turn the run was never seen to read; otherwise nothing is sent.
   *
   *  * `revised` → the stranded changes are now ONE revision: `queued` clears and
   *    `lateRevision` is set.
   *  * `refused` → nothing was revised: `refusedForward` carries the joined texts
   *    and the reason, for the composer to take back.
   *  * `none` → nothing was stranded (the run read them after the last poll): the
   *    queued turns are marked read.
   *
   * A failed call is not a finding: the turns stay queued and the thread keeps
   * them — the person's words are never removed from the record.
   */
  const claimLateChanges = useCallback(async (runJobId: string, signal: AbortSignal) => {
    const sessionId = stateRef.current.session?.id;
    if (!sessionId || !stateRef.current.queued.some((t) => !t.read)) return;
    const strandedIds = stateRef.current.queued.filter((t) => !t.read).map((t) => t.id);
    try {
      const answer = await submitLateChanges(sessionId, runJobId, signal);
      if (!mountedRef.current) return;
      if (answer.outcome === 'revised') {
        setState((s) => ({
          ...s,
          queued: [],
          lateRevision: {
            planId: answer.planId,
            revisionJobId: answer.revisionJobId,
            count: answer.texts.length,
            entryIds: strandedIds,
          },
        }));
      } else if (answer.outcome === 'refused') {
        setState((s) => ({
          ...s,
          queued: [],
          refusedForward: { text: answer.texts.join('\n\n'), code: answer.code },
        }));
      } else {
        setState((s) => ({ ...s, queued: s.queued.map((t) => ({ ...t, read: true })) }));
      }
    } catch {
      /* the turns stay queued; the next end-of-run (or a reload) asks again. */
    }
  }, []);

  const finishPlanRun = useCallback(
    async (
      jobId: string,
      planId: string | undefined,
      anchor: RunAnchor | null,
      controller: AbortController,
    ) => {
      let failed = false;
      // Anchored runs subscribe through the item's own relay (which re-gates the
      // anchor on subscribe); the project thread keeps the shipped augment SSE.
      const stream = anchor
        ? (
            onError: (code: string | null) => void,
            onDone: () => void,
            onFrame: (event: string, data: unknown) => void,
            onLost: () => void,
          ) =>
            streamContextualPlanJob(
              anchor.anchorId,
              jobId,
              controller.signal,
              onError,
              onDone,
              onFrame,
              onLost,
            )
        : (
            onError: (code: string | null) => void,
            onDone: () => void,
            onFrame: (event: string, data: unknown) => void,
            onLost: () => void,
          ) => streamAugmentJob(jobId, controller.signal, onError, onDone, onFrame, onLost);
      // The JOB's own status, as its `status` frames report it (MOTIR-7985). The
      // stream ending says only that a connection closed; this says whether the
      // run did, and how. `null` when no status frame arrived at all.
      let jobStatus: string | null = null;
      let lastSeq = 0;
      // ⚠️ THE CONNECTION THREW (MOTIR-9186): a fetch or read rejected under a run —
      // a locked screen, a sleeping laptop. That is no word from the server, so it
      // is not a failure: the loop subscribes again and the job's own status frames
      // say how it went.
      let lost = false;
      let lostInARow = 0;
      for (let attempt = 0; ; attempt++) {
        lost = false;
        const seenBefore = lastSeq;
        const statusBefore = jobStatus;
        await stream(
          (code) => {
            failed = true;
            if (!mountedRef.current) return;
            const gated = code !== null && OUT_OF_CREDITS_CODES.has(code);
            // The thread and any PRIOR proposal survive — recoverable in place.
            setState((s) => ({
              ...s,
              phase: s.review ? 'review' : 'idle',
              progress: null,
              liveReview: null,
              errorCode: gated ? null : (code ?? 'FAILED'),
              outOfCredits: gated,
            }));
          },
          () => {},
          (event, data) => {
            if (event === 'status') {
              const status = frameField(data, 'status');
              if (typeof status === 'string') {
                // A re-subscribe opens on the status it left off at: not news.
                if (status === jobStatus) return;
                jobStatus = status;
              }
            } else {
              // A re-subscribe replays the job from its first frame; the rail
              // has narrated those already.
              const seq = frameField(data, 'seq');
              if (typeof seq === 'number') {
                if (seq <= lastSeq) return;
                lastSeq = seq;
              }
            }
            if (!mountedRef.current) return;
            // THE CONVERSATION PHASE IS OVER (MOTIR-8203): the planner has settled
            // what it is planning, so the hand-off becomes true. Quiet on the act
            // rail; it moves only the phase.
            if (event === 'target_settled') {
              setState((s) => (s.settledJobId === jobId ? s : { ...s, settledJobId: jobId }));
            }
            // APPEND, REPLACE the live line, or MARK an earlier call — one update,
            // decided by `applyPlanFrame` (MOTIR-7976). A quiet frame changes
            // nothing, which is the decision the disposition map recorded rather
            // than a frame falling through.
            setState((s) => {
              const next = applyPlanFrame(s, event, data);
              return next === s ? s : { ...s, ...next };
            });
          },
          () => {
            lost = true;
          },
        );
        if (failed || controller.signal.aborted || !mountedRef.current) break;
        // Progress between two losses means the connection works; only a stream that
        // cannot be reached at all runs the count out.
        lostInARow =
          lost && lastSeq === seenBefore && jobStatus === statusBefore ? lostInARow + 1 : 0;
        if (lost && lostInARow >= MAX_LOST_RESUBSCRIBES) {
          failed = true;
          if (mountedRef.current) {
            setState((s) => ({
              ...s,
              phase: s.review ? 'review' : 'idle',
              progress: null,
              liveReview: null,
              errorCode: 'FAILED',
              outOfCredits: false,
            }));
          }
          break;
        }
        // ⚠️ THE STREAM ENDED, THE JOB DID NOT (MOTIR-7985). The relay follows the
        // job past motir-ai's stream window itself, so this is a connection that
        // closed under a run still going — a dropped network, a restarted
        // server. Settling here would tell the person "Nothing came back" about a
        // run that is still working, so the rail subscribes again instead.
        // A LOST connection with no terminal status seen resubscribes even when no
        // status frame arrived yet: the job's state is simply unknown, not absent.
        if (!lost && jobStatus === null) break;
        if (jobStatus !== null && TERMINAL_JOB_STATUSES.has(jobStatus)) break;
        await pauseBeforeResubscribe(attempt, controller.signal);
        if (controller.signal.aborted || !mountedRef.current) break;
      }
      // ⚠️ THE WALK IS OVER (MOTIR-7997): a change the person forwarded that the run
      // never read — it was accepted while the job was still validating and closing
      // the plan — is stranded in the mailbox. Ask the server once to claim it and
      // submit it as ONE revision of this plan, or hand it back with the reason.
      // Only an unread forwarded turn triggers it, so an ordinary run (nobody typed
      // anything) makes no request, and only a run whose end the stream actually
      // reported (never an aborted or unmounted one).
      if (
        (failed || (jobStatus !== null && TERMINAL_JOB_STATUSES.has(jobStatus))) &&
        mountedRef.current &&
        !controller.signal.aborted
      ) {
        await claimLateChanges(jobId, controller.signal);
      }
      if (!failed && jobStatus === 'failed') {
        // The job FAILED and no reason arrived with it (the relay sends one when
        // motir-ai has it). Still a failure, never "nothing came back".
        failed = true;
        if (mountedRef.current) {
          setState((s) => ({
            ...s,
            phase: s.review ? 'review' : 'idle',
            progress: null,
            liveReview: null,
            errorCode: 'FAILED',
            outOfCredits: false,
          }));
        }
      }
      if (failed) {
        // The run is OVER at the failure: release it before the end re-read, or
        // a Try again pressed while the re-read waits would find a run still in
        // flight and do nothing.
        if (abortRef.current === controller) abortRef.current = null;
        if (!mountedRef.current) return null;
        const resumed = await settleEnd(controller.signal, jobId);
        return resumed && !controller.signal.aborted && mountedRef.current ? resumed : null;
      }
      if (!mountedRef.current) return;
      const canceled = jobStatus === 'canceled';

      // SETTLED → first, let the PLANNER SPEAK (MOTIR-2226). The run's result
      // carries the findings report it owes on every turn, and the one question
      // it asks when the request was not determinate; recording it here is what
      // puts either into the persisted thread. Best-effort and non-fatal: a
      // failed recording costs the narration, never the proposals, so it must
      // not take the run down with it.
      let asked = false;
      let declined = false;
      try {
        const sessionId = stateRef.current.session?.id;
        if (!sessionId) throw new Error('no session to narrate into');
        const withTurn = await recordPlannerTurn(sessionId, jobId, anchor, controller.signal);
        if (!mountedRef.current) return;
        asked = pendingQuestion(withTurn.turns) !== null;
        declined = latestTurnDeclined(withTurn.turns) || latestTurnUnsearchable(withTurn.turns);
        setState((s) => ({ ...s, session: withTurn }));
      } catch {
        /* the run still happened; the thread simply carries no narration */
      }

      // Then read what the run actually PROPOSED, from its Plan. The job
      // result's `planDelta` is not consulted: it is empty by construction. The
      // read is the run's ONE: if the live poll already handed over, this is it.
      const pending = planId ? await readProposalOnce(planId, controller.signal) : null;
      if (!mountedRef.current) return;
      if (pending) {
        setState((s) => ({
          ...s,
          phase: 'review',
          review: fileReview(s.review, pending),
          liveReview: null,
          progress: null,
          errorCode: null,
          // THE PLAN SURVIVES A STOP. A run stopped after it had appended a level
          // settles here, with `pending` holding exactly what it proposed before
          // the stop — so the review block is live and Approve / Discard are both
          // reachable from the stopped state. That is the card's whole point: if
          // stopping threw the work away, nobody would stop a run.
          ...(s.stopping || canceled ? { stopping: false, stopped: true } : {}),
        }));
        stoppingRef.current = false;
      } else {
        // Nothing came back. The thread stays; the previous proposal (if any) too.
        //
        // A turn that ASKED proposes nothing BY DESIGN — the planner is blocked
        // on the answer and the canvas stays untouched (design state B) — so
        // "nothing came back to change" would be a false error on the one turn
        // where the rail has the most to say. The question is the outcome.
        setState((s) => ({
          ...s,
          phase: s.review ? 'review' : 'idle',
          progress: null,
          liveReview: null,
          // ⚠️ A STOPPED RUN IS THE THIRD REASON NOTHING CAME BACK, and without
          // this arm it would surface as `EMPTY` — a failure banner on the one
          // outcome the user chose deliberately (MOTIR-4068). The three are:
          // the planner ASKED and is waiting (`asked`); the user STOPPED it
          // (`s.stopping`); or the run genuinely proposed nothing, which is the
          // only one that is an error.
          // A job CANCELED under the rail — a Stop pressed elsewhere, the
          // abandoned-plan sweep — is the same outcome as a stop pressed here
          // (MOTIR-7985): `EMPTY` is only ever a run that SUCCEEDED with nothing.
          // A turn DECLINED for an unreadable code graph writes no plan by design
          // and the rail draws its own notice (MOTIR-8136): the fourth reason, and
          // not an error either (MOTIR-8564). A turn that STOPPED because a target
          // repository's code cannot be searched is the same outcome, drawn as a
          // banner (MOTIR-9165).
          errorCode: asked || declined || s.stopping || canceled ? null : 'EMPTY',
          // The interval closes HERE and only here: the stream has ended, so the
          // walk reached its boundary and read the flag. Until this moment the
          // bar says "stopping", which is the honest thing to say.
          ...(s.stopping || canceled ? { stopping: false, stopped: true } : {}),
        }));
        stoppingRef.current = false;
      }
    },
    [readProposalOnce, settleEnd, claimLateChanges],
  );

  /** Submit the thread's ACCUMULATED intent, then stream + settle the job. Shared
   *  by `send` (after the turn is appended) and `retry` (nothing new to append).
   *
   *  `submitter` is what actually sends: the project submit, the anchored
   *  resubmit, or — anchored — the ONE call that appends the new turn AND submits
   *  it (the MOTIR-909 contract fuses those two). Everything downstream (stream,
   *  settle, review) is identical for both threads; only the URL differs. */
  /**
   * FOLLOW AN AUTOMATIC RESUME (Story MOTIR-8301 · bug MOTIR-8336). The failed run's re-read
   * found its session resumed by itself — a lost machine's relay starts the new attempt before
   * the stream closes. The new job goes through `run` exactly as a pressed Resume's does: it
   * clears the failure the stream reported, re-arms the live poll on the SAME plan (which reads
   * *resuming* until the job writes), and subscribes to the new stream, whose relay is what
   * records the next loss. Through a ref, because `run` is what calls it.
   */
  const runRef = useRef<RunFn | null>(null);
  const followAutoResume = useCallback(
    async (anchor: RunAnchor | null, session: PlanChangeSessionDto, planId: string | null) => {
      const jobId = session.lastJobId;
      if (!jobId || !mountedRef.current) return;
      await runRef.current?.(anchor, async () => ({
        jobId,
        ...(planId ? { planId } : {}),
        session,
      }));
    },
    [],
  );

  const run = useCallback(
    async (
      anchor: RunAnchor | null,
      submitter?: (
        signal: AbortSignal,
      ) => Promise<{ jobId: string; planId?: string; session: PlanChangeSessionDto }>,
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      resetLiveRun();
      // The previous run's job is OVER: until this run's id comes back there is
      // no job to stop, and a Stop pressed now waits for it (MOTIR-7924).
      setState((s) => ({ ...s, jobId: null }));
      let livePlan: string | null = null;
      // A lost machine's session Motir resumed by itself (bug MOTIR-8336), followed below.
      let resumedBy: PlanChangeSessionDto | null = null;
      // Remembered before the hop, so a retry after a failure re-sends to the
      // thread this turn actually landed in.
      lastAnchorRef.current = anchor;
      const submit =
        submitter ??
        (anchor
          ? (signal: AbortSignal) =>
              resubmitContextualPlan(
                anchor.anchorId,
                anchor.targetKeys,
                signal,
                stateRef.current.session?.id ?? null,
              )
          : (signal: AbortSignal) => submitPlanChange(stateRef.current.session?.id ?? '', signal));

      try {
        const { jobId, planId, session } = await awaitSubmit(submit(controller.signal));
        if (!mountedRef.current) return;
        const carried = takePendingStop();
        // The hosted run's plan is watched live from the moment it is known.
        livePlan = planId ?? null;
        setLivePlanId(livePlan);
        setState((s) => ({
          ...s,
          phase: 'streaming',
          session,
          jobId,
          // A new run supersedes whatever the resume re-attached to, so this is
          // an assignment, not a merge — `undefined` (a stub) clears it.
          planId: planId ?? null,
          // …and it supersedes a DECIDED overlay (MOTIR-3162). The review is kept
          // THROUGH the decision so the canvas can draw it; a new run is the
          // moment it stops describing anything, so a decided overlay can never
          // bleed into the next generation.
          //
          // ⚠️ Only a DECIDED one. A still-pending proposal survives a run,
          // because `retry` comes through here too and a retry CONTINUES the
          // conversation rather than restarting it — clearing unconditionally
          // would drop a proposal the user is still looking at and the server
          // still awaits a decision on.
          review: s.decided ? null : s.review,
          liveReview: null,
          discardedReview: null,
          decided: null,
          ...firstAct('submitted'),
          errorCode: null,
          outOfCredits: false,
          // The send went through, so nothing holds its targets from this person.
          targetHeld: null,
          // A NEW run is not stopped, and neither is a retry (MOTIR-4068). Both
          // flags are per-RUN: leaving them set would carry a previous run's
          // ending onto the one just started, which is the mirror of the bug
          // this state exists to prevent. The one thing carried is a stop
          // pressed for THIS run before its job id was known (MOTIR-7924).
          stopping: carried,
          stopped: false,
          // The mailbox is per-RUN, so the queue is too: a new job has an empty
          // one, and carrying the last run's turns into it would show the user
          // sentences that can never be read again.
          queued: [],
        }));
        stoppingRef.current = carried;
        if (carried) void raiseStop(session.id, jobId);

        resumedBy = (await finishPlanRun(jobId, planId, anchor, controller)) ?? null;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        refuseRun(err, controller);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        endLive(livePlan);
        releasePendingStop();
        // AFTER `endLive`: the follow re-arms the live poll this run just released.
        if (resumedBy) await followAutoResume(anchor, resumedBy, livePlan);
      }
    },
    [
      finishPlanRun,
      followAutoResume,
      resetLiveRun,
      endLive,
      refuseRun,
      awaitSubmit,
      raiseStop,
      takePendingStop,
      releasePendingStop,
    ],
  );
  runRef.current = run;

  /**
   * Run ONE turn through the ask door — the project thread's only entrance since
   * MOTIR-1343 (`docs/decisions/conversation-turn-intent.md` §2).
   *
   * The shape is deliberately NOT "ask, and separately plan": the client posts
   * text, streams the `ask_project` job, and asks the server what it produced.
   * Exactly one of three things comes back, and the third is the interesting one:
   *
   *  * `answered` — an assistant turn with its citations is on the thread.
   *  * `silent`   — the job said nothing at all. Core persists nothing for it
   *    (inventing a body would be motir-core writing the assistant's words), so
   *    the rail says so honestly rather than showing an empty bubble.
   *  * `redirected` — the turn was a plan change. From here the run hands off to
   *    {@link finishPlanRun}, the SAME tail a plan-change submit uses, so the
   *    shipped diff + confirm chrome returns in the same thread.
   *
   * ⚠️ THE WAITING STATE IS CONTINUOUS ACROSS THE HAND-OFF. `phase` stays
   * `streaming` and only `progress` changes, because a bubble that unmounts and
   * returns reads as "that failed, it is trying again" — and nothing failed.
   */
  const runAsk = useCallback(
    async (
      submitter: (signal: AbortSignal) => Promise<AskSubmitResponse | AskRedirectResponse>,
      /** The work item this turn is anchored on (MOTIR-7050), or null. */
      anchorKey: string | null = null,
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      resetLiveRun();
      // The previous run's job is OVER — above all a finished ask's, which the
      // stop door never matched (MOTIR-7924). Until this run's id comes back a
      // Stop has nothing to post, so it waits for the job instead.
      setState((s) => ({ ...s, jobId: null }));
      let livePlan: string | null = null;
      // A plan run this ask handed over to, resumed by itself after a lost machine (MOTIR-8336).
      let resumedBy: PlanChangeSessionDto | null = null;
      // An ask is project-wide by construction, so a retry after one must not
      // re-aim at an anchor an earlier plan-change run happened to use.
      lastAnchorRef.current = null;
      lastAskAnchorRef.current = anchorKey;

      /** The run ENDED on a settle — answered, landed or silent. */
      const settleTo = (settled: AskSettleResponse) => {
        setState((s) => ({
          ...s,
          session: settled.session,
          phase: s.review ? 'review' : 'idle',
          progress: null,
          // The ask is OVER, so its record closes (bug MOTIR-7924): the opening
          // `reading` act would otherwise stay under the answer saying "Reading
          // your request…", and the finished job id would stay in state for the
          // NEXT run's Stop to post — a job the stop door never matched.
          acts: withoutReading(s.acts),
          jobId: null,
          // `silent` is NOT the honest "I could not find that" — that is prose
          // the handler returns, and it lands as an ordinary answer with no
          // citations. This is the job producing nothing at all.
          errorCode: settled.outcome === 'silent' ? 'ASK_SILENT' : null,
        }));
      };

      try {
        const submitted = await awaitSubmit(submitter(controller.signal));
        if (!mountedRef.current) return;

        // REDIRECTED AT THE DOOR — no ask job was opened at all. Two turns reach
        // this: a reply to the planner's pending question (the affordance
        // already settled the disposition, so there was nothing to classify) and
        // a re-run the handler hands back before streaming.
        //
        // There is no hand-off to name here, because nothing was read and
        // re-read: the run IS a plan-change run from its first frame, and the
        // waiting row says what it has always said for one.
        if ('outcome' in submitted) {
          lastAskTurnRef.current = null;
          lastAskAnchorRef.current = null;
          // THE CORRECTION'S PLAN JOB (MOTIR-7924): a Stop pressed while its
          // submit was in flight is raised HERE, on the job it was meant for.
          const carried = takePendingStop();
          livePlan = submitted.planId ?? null;
          setLivePlanId(livePlan);
          setState((s) => ({
            ...s,
            phase: 'streaming',
            session: submitted.session,
            jobId: submitted.jobId,
            planId: submitted.planId,
            review: s.decided ? null : s.review,
            liveReview: null,
            discardedReview: null,
            decided: null,
            ...firstAct('submitted'),
            errorCode: null,
            outOfCredits: false,
            stopping: carried,
            stopped: false,
            queued: [],
          }));
          stoppingRef.current = carried;
          if (carried) void raiseStop(submitted.session.id, submitted.jobId);
          resumedBy =
            (await finishPlanRun(submitted.jobId, submitted.planId, null, controller)) ?? null;
          return;
        }

        lastAskTurnRef.current = submitted.turnId;
        setState((s) => ({
          ...s,
          phase: 'streaming',
          session: submitted.session,
          jobId: submitted.jobId,
          planId: null,
          // The same supersede rule `run` applies: a DECIDED overlay stops
          // describing anything the moment a new run starts; a still-pending
          // proposal survives, because asking a question mid-review is a lookup
          // and not an abandonment.
          review: s.decided ? null : s.review,
          decided: null,
          ...firstAct('reading'),
          errorCode: null,
          outOfCredits: false,
          // A NEW run is not stopped, and neither is a retry (MOTIR-4068). Both
          // flags are per-RUN: leaving them set would carry a previous run's
          // ending onto the one just started, which is the mirror of the bug
          // this state exists to prevent. A stop pressed for THIS run during its
          // submit is kept: an ask job is not one the stop door addresses, so it
          // waits for the plan job the ask may hand off to (MOTIR-7924).
          stopping: pendingStopRef.current,
          stopped: false,
          // The mailbox is per-RUN, so the queue is too: a new job has an empty
          // one, and carrying the last run's turns into it would show the user
          // sentences that can never be read again.
          queued: [],
          // The turn's ANCHOR, remembered by turn (MOTIR-7050) so the rail can
          // draw it on the bubble the person just sent.
          ...(anchorKey
            ? { turnAnchors: { ...(s.turnAnchors ?? {}), [submitted.turnId]: anchorKey } }
            : {}),
        }));
        unstoppableJobRef.current = submitted.jobId;
        stoppingRef.current = pendingStopRef.current;

        let failed = false;
        await streamAskJob(
          submitted.jobId,
          controller.signal,
          (code) => {
            failed = true;
            if (!mountedRef.current) return;
            const gated = code !== null && OUT_OF_CREDITS_CODES.has(code);
            setState((s) => ({
              ...s,
              phase: s.review ? 'review' : 'idle',
              progress: null,
              acts: withoutReading(s.acts),
              errorCode: gated ? null : (code ?? 'FAILED'),
              outOfCredits: gated,
            }));
          },
          () => {},
          // The ask job's LOOKUPS (`retrieval` frames, MOTIR-7923) are quiet by the
          // shared disposition map, as a plan run's are (MOTIR-8158): they mean
          // nothing to the person. So are its phase frames (`status`,
          // `retrieval_ready`) — a redirect's hand-off is drawn by the settle below.
          (event, data) => {
            if (!mountedRef.current) return;
            const progress = narrateFrame(event, data);
            if (progress) setState((s) => ({ ...s, progress, acts: [...s.acts, progress] }));
          },
        );
        if (failed) {
          // Released before the end re-read, as a plan run's failure is.
          if (abortRef.current === controller) abortRef.current = null;
          if (mountedRef.current) await settleEnd(controller.signal);
          return;
        }
        if (!mountedRef.current) return;

        const settleSessionId = submitted.session?.id ?? stateRef.current.session?.id ?? null;
        const settled = await settleAskJob(submitted.jobId, controller.signal, settleSessionId);
        if (!mountedRef.current) return;

        if (settled.outcome === 'redirected') {
          const redirect = settled;
          // A Stop pressed while the ASK streamed was held for this job (MOTIR-7924).
          const carried = takePendingStop();
          livePlan = redirect.planId ?? null;
          setLivePlanId(livePlan);
          setState((s) => ({
            ...s,
            session: redirect.session,
            jobId: redirect.jobId,
            planId: redirect.planId,
            // A plan run starts here, so an earlier discarded plan stops describing it.
            discardedReview: null,
            // The hand-off is an act like any other: it joins the record as well
            // as replacing the live line (MOTIR-4069).
            progress: { kind: 'redirected' },
            acts: [...s.acts, { kind: 'redirected' }],
          }));
          if (carried) void raiseStop(redirect.session.id, redirect.jobId);
          resumedBy =
            (await finishPlanRun(redirect.jobId, redirect.planId, null, controller)) ?? null;
          return;
        }

        settleTo(settled);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        refuseRun(err, controller);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        endLive(livePlan);
        releasePendingStop();
        if (resumedBy) await followAutoResume(null, resumedBy, livePlan);
      }
    },
    [
      finishPlanRun,
      followAutoResume,
      resetLiveRun,
      endLive,
      refuseRun,
      awaitSubmit,
      settleEnd,
      raiseStop,
      takePendingStop,
      releasePendingStop,
    ],
  );

  /** A carry is IN FLIGHT — set before the await, as `restartingRef` is, so a
   *  second Enter in the same tick finds it set. */
  const carryingRef = useRef(false);

  /**
   * THE FIRST SEND ON AN ENDED SESSION WHOSE PLAN STILL WAITS (Story MOTIR-7928 ·
   * MOTIR-7932; AMENDMENT 23 §6 as amended by MOTIR-7931). One call carries the
   * conversation, the plan and this turn into a new session; the server decides
   * which of three answers comes back, and the overlay follows it:
   *
   *  · a NEW session — swap to it through the restart's path (the host re-keys the
   *    address), say the plan moved, and stream the planner's answer to the turn
   *    already appended (the session's submit revises the same plan in place);
   *  · `takenBack` — the person's OPEN session of the scope took the turn: swap to
   *    it and point back at the plan that still waits here;
   *  · `PLAN_SESSION_PLAN_DECIDED` — refused in place: the session does not change,
   *    the words are kept, and the plan is re-read showing its decision.
   */
  const carrySend = useCallback(
    async (text: string, anchorKey: string | null) => {
      const from = stateRef.current.session;
      if (!from || abortRef.current || carryingRef.current) return;
      carryingRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      const isAnswer = pendingQuestion(from.turns) !== null;
      setState((s) => ({
        ...s,
        carrying: { text },
        errorCode: null,
        outOfCredits: false,
        targetHeld: null,
        carryDecided: null,
      }));
      let landed: PlanChangeSessionDto;
      try {
        landed = await startCopiedSession(
          from.id,
          { body: text, isAnswer, anchorKey },
          controller.signal,
        );
      } catch (err) {
        carryingRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        if (err instanceof PlanSessionPlanDecidedClientError) {
          const planId = err.planId ?? from.pendingPlanId ?? stateRef.current.planId;
          const [review, read] = await Promise.all([
            planId ? fetchPlanReview(planId).catch(() => null) : Promise.resolve(null),
            getPlanChangeSession(from.id).catch(() => null),
          ]);
          if (!mountedRef.current) return;
          const status = review?.status ?? err.planStatus;
          setState((s) => ({
            ...s,
            carrying: null,
            carryDecided: { text },
            // The plan is no longer waiting, whatever the re-read could say: the
            // slot gives way to the decided session's read-only line.
            session: read ?? (s.session ? { ...s.session, pendingPlanId: null } : s.session),
            review: review ? fileReview(s.review, review) : s.review,
            decided:
              status === 'approved' ? 'accepted' : status === 'declined' ? 'declined' : s.decided,
            planId: null,
            phase: 'idle',
          }));
          return;
        }
        const held = targetHeldFrom(err);
        setState((s) => ({
          ...s,
          carrying: null,
          ...(held ? { targetHeld: held } : { errorCode: 'FAILED' }),
        }));
        return;
      }
      carryingRef.current = false;
      if (abortRef.current === controller) abortRef.current = null;
      if (!mountedRef.current) return;

      const takenBack = landed.takenBack === true;
      adoptedSessionRef.current = landed.id;
      lastAskTurnRef.current = null;
      lastAskAnchorRef.current = null;
      setState((s) => ({
        ...s,
        carrying: null,
        session: landed,
        // The carried session holds THE SAME plan: the review stays on the canvas.
        // A take-back lands on another session, so the plan in hand is not its own.
        ...(takenBack
          ? {
              review: null,
              liveReview: null,
              decided: null,
              planId: null,
              phase: 'idle' as const,
            }
          : {}),
        carriedFrom: takenBack ? null : from.id,
        takenBackWaitingPlanId: takenBack ? (from.pendingPlanId ?? s.planId) : null,
        reopened: null,
        restartedFrom: null,
        readOnly: false,
        copyable: null,
        stalePlan: null,
      }));
      restartedCbRef.current?.(landed.id);
      // A take-back's turn waits in that session like any appended turn.
      if (takenBack) return;
      await run(null, (signal) => submitPlanChange(landed.id, signal));
    },
    [run],
  );

  /**
   * PLAN IT AGAIN (MOTIR-7945's accept; design state 10): ONE fresh plan in this
   * session from this conversation. The ref guards the double press before any
   * render lands, and the server is idempotent behind it. The run attaches to the
   * new plan exactly as an ordinary submit does; a plan restored to `planned` meanwhile
   * comes back as an ordinary revise of it.
   */
  const planAgain = useCallback(async () => {
    const stale = stateRef.current.stalePlan;
    const session = stateRef.current.session;
    if (!stale || stale.outcome || !session || planAgainRef.current || abortRef.current) return;
    planAgainRef.current = true;
    setState((s) => ({
      ...s,
      stalePlan: s.stalePlan ? { ...s.stalePlan, pressing: true } : null,
    }));
    try {
      await run(null, async (signal) => {
        const result = await submitPlanChange(session.id, signal, { planAgainOf: stale.planId });
        if (mountedRef.current) {
          setState((s) => ({
            ...s,
            stalePlan: s.stalePlan
              ? {
                  ...s.stalePlan,
                  pressing: false,
                  outcome: result.planId === stale.planId ? 'restored' : 'accepted',
                }
              : null,
          }));
        }
        return result;
      });
    } finally {
      planAgainRef.current = false;
    }
  }, [run]);

  /**
   * Append what the user typed, then run the ACCUMULATED intent.
   *
   * `targets` is the `@`-mention picker's TARGET SET (MOTIR-1491) and, when
   * given, it is AUTHORITATIVE: its first entry is the primary anchor and the
   * rest ride as additional ones — so removing every target really does make the
   * turn project-wide, rather than silently keeping the entrance's item. Omitting
   * the argument entirely means "no opinion about targets", which falls back to
   * the entrance anchor (MOTIR-910's per-item workspace).
   */
  const send = useCallback(
    async (
      text: string,
      targets?: readonly PlanningTarget[],
      /**
       * `anchorKey` — the ONE work item a PROJECT-thread turn is about
       * (MOTIR-7047 · MOTIR-7050): the report widget's seeded turn names
       * the triage bug it just filed. It is data for the ask door, not a target
       * set — the turn stays on the project thread — and it is ignored on an
       * anchored (item) thread, which has no ask door.
       */
      options: { anchorKey?: string | null } = {},
    ) => {
      const body = text.trim();
      if (!body) return;
      // An ENDED session accepts no turn (AMENDMENT 23 §3): the composer is not
      // drawn for one, and a stale click must not reach the server either — unless
      // its plan still waits, when the send CARRIES it into a new session (MOTIR-7932).
      if (sessionEnded(stateRef.current.session)) {
        if (carriesWaitingPlan(stateRef.current.session, stateRef.current.readOnly)) {
          // The carry keeps the ended session's SCOPE, so it can only carry a turn
          // for that scope. A composer whose targets name something else is not a
          // carry: the plan that waits belongs to the old scope, and the turn goes
          // out as a fresh targeted one (MOTIR-8983).
          if (planningTargetsMatchSession(targets, stateRef.current.session)) {
            await carrySend(body, options.anchorKey ?? null);
            return;
          }
        } else {
          return;
        }
      }
      // A stale notice still offering Plan it again is answered by this turn; one
      // that was acted on stays as the thread's record.
      if (stateRef.current.stalePlan && !stateRef.current.stalePlan.outcome) {
        setState((s) => ({ ...s, stalePlan: null }));
      }

      // ⚠️ THE RUN IS STILL WORKING → THE MAILBOX, NOT THE SUBMIT (MOTIR-4274).
      //
      // ⚠️ AND THIS SITS ABOVE THE `abortRef` BAIL DELIBERATELY. That guard —
      // `if (abortRef.current) return` — is the SECOND place the composer was
      // locked during a run, and the one that is invisible: the `disabled` prop
      // is what a reader sees, and this is what actually refused the call. It was
      // right when a run was a monologue (there was nowhere for the turn to go,
      // so a second send could only mean a second job) and it is wrong now, for
      // exactly the same reason the prop was.
      //
      // It still guards the SUBMIT path below, which is what it was written for:
      // a mid-run turn must never start a second job, and that remains true —
      // the turn goes to the mailbox instead of being dropped.
      //
      // One control, two destinations, chosen by the phase — and the user does
      // not have to know which. Both wrong answers are SILENT: a mid-run turn
      // sent down the submit path opens a SECOND planning job on a thread that
      // already has one, and a between-runs turn sent to the mailbox lands in a
      // box nothing will ever check. So the branch is here, once, before either
      // door is chosen.
      //
      // It starts nothing. The run reads this at its next phase boundary, which
      // can be a whole authoring session away, so the turn is QUEUED until it
      // does — and the surface says so rather than looking delivered.
      if (stateRef.current.phase === 'streaming') {
        const jobId = stateRef.current.jobId;
        if (!jobId) return;
        // ⚠️ A PLANNING RUN IS WORKING (MOTIR-7996; ADR AMENDMENT 4) → THE ANSWERING
        // SESSION, NOT THE MAILBOX. The turn is read before it can reach the walk:
        // a question is answered on the thread, an unsure turn is answered with an
        // offer to forward, and only a change is forwarded (by the settle).
        //
        // It applies only when the running job IS a planning run (`planId` set); an
        // ask streaming on its own keeps the path below. And it NEVER touches
        // `jobId`, `phase`, `stopping` or the run's `abortRef`: the planning run and
        // its Stop are unaffected, the ask streams and settles on its own controller.
        // …EXCEPT while the planner's `unclear` question is open (MOTIR-8010): the
        // turn IS its answer, sent to the pause door — never given a verdict by the
        // answering session, never a second run, and `midRunAsk` is not set.
        if (isOpenUnclear(pauseOf(stateRef.current))) {
          await answerRunPause('reply', body);
          return;
        }
        const midRunPlanId = stateRef.current.planId;
        const midRunSessionId = stateRef.current.session?.id;
        if (midRunPlanId && midRunSessionId) {
          const controller = new AbortController();
          midRunAbortsRef.current.add(controller);
          // A session copy from the server is adopted only if it is not OLDER than
          // what the rail holds (turns only grow), so a slow settle cannot roll the
          // thread back over a newer write.
          const adopt = (
            s: PlanChangeConversationState,
            incoming: PlanChangeSessionDto,
          ): PlanChangeSessionDto =>
            s.session && s.session.id === incoming.id && s.session.turnCount > incoming.turnCount
              ? s.session
              : incoming;
          setState((s) => ({
            ...s,
            refusedForward: null,
            lateRevision: null,
            midRunAsk: { text: body },
          }));
          try {
            const submitted = await submitMidRunAskTurn(
              midRunSessionId,
              jobId,
              midRunPlanId,
              body,
              controller.signal,
            );
            if (!mountedRef.current) return;
            setState((s) => ({ ...s, session: adopt(s, submitted.session) }));
            let failed = false;
            await streamAskJob(
              submitted.jobId,
              controller.signal,
              (code) => {
                failed = true;
                if (!mountedRef.current) return;
                const gated = code !== null && OUT_OF_CREDITS_CODES.has(code);
                // The RUN's phase is not this ask's to change; only the error shows.
                setState((s) => ({
                  ...s,
                  errorCode: gated ? s.errorCode : (code ?? 'FAILED'),
                  outOfCredits: gated || s.outOfCredits,
                }));
              },
              () => {},
            );
            if (failed || !mountedRef.current) return;
            const settled = await settleAskJob(submitted.jobId, controller.signal, midRunSessionId);
            if (!mountedRef.current) return;
            if (settled.outcome === 'forwarded') {
              const delivery = settled.delivery;
              setState((s) => ({
                ...s,
                session: adopt(s, settled.session),
                // The whole pending set, as the mailbox door answered it; the shipped
                // poll reports each one read.
                queued: delivery.turns.map((t) => ({ id: t.id, text: t.text, read: false })),
              }));
            } else if (settled.outcome === 'revised_late') {
              setState((s) => ({
                ...s,
                session: adopt(s, settled.session),
                lateRevision: {
                  planId: settled.planId,
                  revisionJobId: settled.revisionJobId,
                  count: 1,
                },
              }));
            } else if (settled.outcome === 'forward_refused') {
              setState((s) => ({
                ...s,
                session: adopt(s, settled.session),
                refusedForward: { text: settled.text, code: settled.code },
              }));
            } else {
              setState((s) => ({ ...s, session: adopt(s, settled.session) }));
            }
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            if (!mountedRef.current) return;
            const code = err instanceof PlanEditsClientError ? err.code : null;
            setState((s) => ({ ...s, errorCode: code ?? 'MAILBOX_FAILED' }));
          } finally {
            midRunAbortsRef.current.delete(controller);
            // The answer is no longer being written — settled, failed or aborted.
            if (mountedRef.current) setState((s) => ({ ...s, midRunAsk: null }));
          }
          return;
        }
        // Per SEND, never per render: a retry of this click must deliver once,
        // and the next sentence must not be swallowed as a replay of this one.
        const idempotencyKey = `turn:${jobId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        try {
          const delivery = await attachMidRunTurn(
            stateRef.current.session?.id ?? '',
            jobId,
            body,
            idempotencyKey,
          );
          if (!mountedRef.current) return;
          setState((s) => ({
            ...s,
            // The door answers with the mailbox AS IT STANDS, so this is the
            // whole pending set rather than a local append — which keeps the
            // count right when a turn was consumed between two sends.
            queued: delivery.turns.map((t) => ({ id: t.id, text: t.text, read: false })),
          }));
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          if (!mountedRef.current) return;
          // A LEGIBLE refusal, and the draft is the caller's to keep. The common
          // one is `PLAN_CHANGE_JOB_NOT_RUNNING` — the run settled between the
          // render and the click — which is a state conflict rather than a
          // failure of the thread, so the conversation is untouched.
          const code = err instanceof PlanEditsClientError ? err.code : null;
          setState((s) => ({ ...s, errorCode: code ?? 'MAILBOX_FAILED' }));
        }
        return;
      }

      // Below here is the SUBMIT path, which still refuses re-entry: a run is in
      // flight and starting a second one is the thing the guard exists to stop.
      if (abortRef.current) return;

      // Is this turn the REPLY to a question the planner is waiting on? Derived
      // from the thread the user was actually looking at when they pressed the
      // button — the same derivation the composer used to decide whether to show
      // the answer bar, so the recorded disposition and the affordance that sent
      // it can never disagree. (Not "did the words answer it" — that judgement is
      // not the code's to make.)
      const isAnswer = pendingQuestion(stateRef.current.session?.turns ?? []) !== null;

      // ANCHORED: appending and submitting are ONE call (MOTIR-909 resolves and
      // view-gates the anchors first, so the contract fuses them) — `run` does
      // the whole hop, and there is no separate append to fail on its own.
      const anchor = resolveAnchor(targets, anchorRef.current);
      if (anchor) {
        // Busy from the click, not from the response: the composer must lock
        // immediately or a second Enter fires a second turn (the project branch
        // below gets this from its own optimistic set).
        setState((s) => ({
          ...s,
          phase: 'streaming',
          // The last run's job is not this one's (MOTIR-7924).
          jobId: null,
          ...firstAct('submitted'),
          errorCode: null,
          outOfCredits: false,
          // A NEW run is not stopped, and neither is a retry (MOTIR-4068). Both
          // flags are per-RUN: leaving them set would carry a previous run's
          // ending onto the one just started, which is the mirror of the bug
          // this state exists to prevent.
          stopping: false,
          stopped: false,
          // The mailbox is per-RUN, so the queue is too: a new job has an empty
          // one, and carrying the last run's turns into it would show the user
          // sentences that can never be read again.
          queued: [],
        }));
        stoppingRef.current = false;
        const heldSession = stateRef.current.session?.id ?? null;
        // The seed rides ONLY the send that has no session yet (MOTIR-6210).
        const seed = heldSession ? null : seedRef.current;
        const guideSeed = heldSession ? null : guideSeedRef.current;
        if (guideSeed) guideSendRef.current = true;
        await run(anchor, (signal) =>
          guideSeed
            ? submitContextualPlan(
                anchor.anchorId,
                body,
                anchor.targetKeys,
                signal,
                isAnswer,
                heldSession,
                null,
                guideSeed,
              )
                .then((sent) => {
                  guideSendRef.current = false;
                  return sent;
                })
                .catch((err: unknown) => {
                  // A refusal is deterministic, so the seed is spent; an outage is not, and
                  // the person's next send must still carry it.
                  if (
                    guideOfferClosedCode(err) !== null ||
                    guideOfferConfirmedSession(err) !== null
                  ) {
                    guideSeedRef.current = null;
                  }
                  throw err;
                })
            : seed
              ? submitContextualPlan(
                  anchor.anchorId,
                  body,
                  anchor.targetKeys,
                  signal,
                  isAnswer,
                  heldSession,
                  seed,
                ).catch((err: unknown) => {
                  if (err instanceof PlanEditsClientError && err.code === 'SEED_NOT_APPLICABLE') {
                    seedRef.current = null;
                  }
                  throw err;
                })
              : submitContextualPlan(
                  anchor.anchorId,
                  body,
                  anchor.targetKeys,
                  signal,
                  isAnswer,
                  heldSession,
                ),
        );
        return;
      }

      // PROJECT: the ONE DOOR (MOTIR-1343). The composer has no switch and sends
      // no intent — `POST /api/ai/ask` appends the turn and submits it, and what
      // the turn turns out to be comes back. A plan change is handed off inside
      // `runAsk`, so this branch does not choose between two endpoints; there is
      // only one, and choosing here is exactly the mode the design does not have.
      //
      // `isAnswer` still rides along (ADR §1's wire table): it is not an intent,
      // it is which affordance sent the turn — the record that lets the thread
      // say later whether the planner's question was answered or superseded.
      setState((s) => ({
        ...s,
        phase: 'streaming',
        // The last run's job is not this one's (MOTIR-7924).
        jobId: null,
        ...firstAct('submitted'),
        errorCode: null,
        outOfCredits: false,
        // Per-RUN, like every other start reducer (MOTIR-4068). The ONE DOOR is
        // still a new run even though it may turn out to be an ask, so a
        // previous run's ending must not be painted onto it.
        stopping: false,
        stopped: false,
        queued: [],
      }));
      stoppingRef.current = false;
      // A pick seeded at the PROJECT (MOTIR-6435) carries its gate on the send that
      // has no session yet, exactly as the anchored branch above does.
      const heldProjectSession = stateRef.current.session?.id ?? null;
      const projectSeed = heldProjectSession ? null : seedRef.current;
      const askAnchor = options.anchorKey ?? null;
      await runAsk(
        (signal) =>
          projectSeed
            ? submitAskTurn(
                body,
                signal,
                isAnswer,
                heldProjectSession,
                projectSeed,
                askAnchor,
              ).catch((err: unknown) => {
                if (err instanceof PlanEditsClientError && err.code === 'SEED_NOT_APPLICABLE') {
                  seedRef.current = null;
                }
                throw err;
              })
            : submitAskTurn(body, signal, isAnswer, heldProjectSession, null, askAnchor),
        askAnchor,
      );
    },
    [run, runAsk, carrySend, answerRunPause],
  );

  /** A Resume is in flight — set before the await, as `stoppingRef` is, so a double-click
   *  finds it set and sends once (MOTIR-7918). */
  const resumingRef = useRef(false);

  /**
   * RESUME a failed-waiting session (Story MOTIR-7905 · MOTIR-7918): continue the SAME plan in
   * the SAME session. The returned job is an ordinary job on the plan the canvas already
   * holds, so it goes through `run` — the stream, the act rail, the live poll and the proposed
   * review hand-off all work unchanged, and `planId` is the returned one (the same plan).
   *
   * `RESUME_ALREADY_STARTED` is no error: a concurrent Resume (another tab, a double click)
   * won, so the stream attaches to the job it carries. Any other refusal keeps the failure
   * line and says why beside it.
   */
  const resume = useCallback(async () => {
    const session = stateRef.current.session;
    if (!session || resumingRef.current || abortRef.current) return;
    if (!sessionAwaitsResume(session)) return;
    resumingRef.current = true;
    setState((s) => ({ ...s, resuming: true, resumeError: null }));
    const anchor =
      lastAnchorRef.current ??
      (anchorRef.current ? { anchorId: anchorRef.current, targetKeys: [] } : null);
    try {
      await run(anchor, async (signal) => {
        try {
          return await resumePlanSession(session.id, signal);
        } catch (err) {
          const winner = resumeAlreadyStartedJobId(err);
          if (winner === null) {
            // Said beside the failure line, which stays (MOTIR-7918); `run`'s own refusal
            // handling still sets the credit paywall / generic state around it.
            if (err instanceof PlanEditsClientError) {
              const code = err.isOutOfCredits ? 'MOTIR_AI_OUT_OF_CREDITS' : (err.code ?? 'FAILED');
              if (mountedRef.current) setState((s) => ({ ...s, resumeError: code }));
              // NOTHING TO RESUME (MOTIR-9121): the server has just recorded the attempt as one
              // that cannot be resumed and given its cards back, so the session row now says so.
              // Adopt it, and the rail draws the plan-again line with an open composer instead of
              // offering the same refused Resume again.
              if (code === 'PLAN_NOT_RESUMABLE') {
                void getPlanChangeSession(session.id)
                  .then((read) => {
                    if (!mountedRef.current) return;
                    setState((s) => (s.session?.id === read.id ? { ...s, session: read } : s));
                  })
                  .catch(() => {});
              }
            }
            throw err;
          }
          return {
            jobId: winner,
            ...(stateRef.current.planId ? { planId: stateRef.current.planId } : {}),
            session: stateRef.current.session ?? session,
          };
        }
      });
    } finally {
      resumingRef.current = false;
      if (mountedRef.current) setState((s) => ({ ...s, resuming: false }));
    }
  }, [run]);

  /** Re-send the accumulated intent after a failure — no new turn, so the
   *  conversation CONTINUES rather than restarting (design panel 6, error).
   *
   *  It resubmits to the thread the FAILED run used (its target set included),
   *  not to whatever is picked now — retrying a turn must not quietly re-aim it.
   *  Before any run, that is the entrance's anchor. */
  const retry = useCallback(async () => {
    if (abortRef.current) return;
    // NO RETRY INSIDE AN ENDED SESSION (MOTIR-7633): a retry would append to a
    // session that accepts no turn. The only way on is a NEW session.
    if (sessionEnded(stateRef.current.session)) return;
    // …AND NONE INSIDE A SESSION WAITING TO RESUME (MOTIR-7918): a retry would submit the turn
    // again and open a SECOND plan beside the `generating` one the session still holds. Resume
    // is the only way on, and the server refuses the submit anyway (MOTIR-7916).
    if (sessionAwaitsResume(stateRef.current.session)) return;
    setState((s) => ({ ...s, errorCode: null, outOfCredits: false }));
    const anchor =
      lastAnchorRef.current ??
      (anchorRef.current ? { anchorId: anchorRef.current, targetKeys: [] } : null);
    // PROJECT thread: re-run the TURN the failed ask was for, not the thread's
    // accumulated intent. No second `user` turn is appended either way — the
    // person said one thing once — but naming the turn is what keeps the retry
    // pointed at what actually failed.
    if (!anchor && lastAskTurnRef.current) {
      const turnId = lastAskTurnRef.current;
      // …and with the ANCHOR it was sent with (MOTIR-7050), so the re-read is
      // about the same work item the first one was.
      const anchorKey = lastAskAnchorRef.current;
      await runAsk(
        (signal) =>
          rerunAskTurn(
            turnId,
            // The anchor rides only when the turn HAS one — an ordinary turn's
            // re-run names no `anchorKey` at all, rather than a `null` one.
            {
              sessionId: stateRef.current.session?.id ?? null,
              ...(anchorKey ? { anchorKey } : {}),
            },
            signal,
          ),
        anchorKey,
      );
      return;
    }
    await run(anchor);
  }, [run, runAsk]);

  /**
   * CORRECT a mis-read turn — the affordance under the assistant bubble (ADR §3).
   *
   * It re-runs the ORIGINAL user turn under the OTHER intent. Nothing is
   * re-typed, no second user turn is appended, and the superseded assistant turn
   * stays on the thread: a correction is a second answer, not an erasure.
   *
   * ⚠️ THE CLIENT NAMES THE TURN, NEVER THE DIRECTION. Which intent to flip TO is
   * derived server-side from what the turn currently ran as — so even the one
   * affordance where a person is explicitly asking for a different reading keeps
   * the intent server-resolved (§1).
   */
  const correctTurn = useCallback(
    async (turnId: string) => {
      if (abortRef.current) return;
      setState((s) => ({
        ...s,
        phase: 'streaming',
        // The finished turn's job is not this run's: a Stop pressed before the
        // correction's own job id comes back waits for it (bug MOTIR-7924).
        jobId: null,
        ...firstAct('reading'),
        errorCode: null,
        outOfCredits: false,
      }));
      // The turn keeps its anchor through a correction too: "Answer this
      // instead" under a diagnosis answers about the same triage bug. The
      // PERSISTED anchor first (MOTIR-7064), so a correction after a reload
      // still carries it.
      const anchorKey =
        stateRef.current.session?.turns.find((t) => t.id === turnId)?.anchorKey ??
        stateRef.current.turnAnchors?.[turnId] ??
        null;
      await runAsk(
        (signal) =>
          rerunAskTurn(
            turnId,
            {
              flip: true,
              sessionId: stateRef.current.session?.id ?? null,
              ...(anchorKey ? { anchorKey } : {}),
            },
            signal,
          ),
        anchorKey,
      );
    },
    [runAsk],
  );

  /**
   * After a refused decision, re-read the review when the refusal is a fact about the
   * PLAN (MOTIR-6038): a stale stamp means the proposals moved under the reader, so the
   * next press must carry the stamp of what they are now shown. Best-effort — a failed
   * re-read leaves the review in hand, and the press is refused stale again.
   */
  const rereadAfterRefusal = useCallback(async (planId: string, err: unknown) => {
    if (!(err instanceof PlanRequestError) || err.code !== 'APPROVAL_GATE_STALE_SUBJECT') return;
    try {
      const fresh = await fetchPlanReview(planId);
      if (!mountedRef.current) return;
      setState((s) => (s.planId === planId ? { ...s, review: fileReview(s.review, fresh) } : s));
    } catch {
      /* keep the review in hand */
    }
  }, []);

  /**
   * PERSIST the proposal — `POST /api/plans/[id]/approve`, which decides the plan's
   * gate through the one decide door (MOTIR-6038) and `materialize`s it, behind the
   * 7.12.5 persist gate. It is the SAME operation `/plans/[id]` performs, on the same
   * Plan: two entrances, one door, no second write path. The press carries the stamp
   * of the review the reader was shown. The thread STAYS.
   */
  const approve = useCallback(async () => {
    const { planId, review } = stateRef.current;
    if (!planId) return;
    setState((s) => ({ ...s, phase: 'deciding', errorCode: null }));

    try {
      const approved = summarizePlanApproval(
        await approvePlanRequest(planId, review?.gate?.stamp ?? null),
      );
      // ⚠️ RE-READ THE DECIDED PLAN (bug MOTIR-3206). The review in hand was read
      // while the plan was `planned`, so every `add` in it is keyed by its
      // PlanItem id and carries no identifier. Keeping the overlay past the
      // decision (MOTIR-3162) therefore drew each accepted card TWICE: once as
      // the committed node the level read now returns, once as the keyless ghost
      // the stale review still describes. `getPlanReview` re-keys a materialized
      // add by the work item it became and fills in its identifier (MOTIR-3160) —
      // only the server knows those ids, so this read is the only way the canvas
      // can land the treatment ON the card.
      //
      // Best-effort by design: a failed re-read leaves the previous review in
      // place, which is the picture that shipped before — worse, never broken.
      // The approve itself has already succeeded and is not re-tried or undone.
      let decidedReview: PlanReviewDto | null = null;
      try {
        decidedReview = await fetchPlanReview(planId);
      } catch {
        /* keep the pre-decision review rather than losing the overlay entirely */
      }
      if (!mountedRef.current) return;
      setState((s) => ({
        ...s,
        phase: 'idle',
        // The review STAYS (MOTIR-3162) — it is the record of what was accepted,
        // and `decided` is what turns it into the accepted treatment.
        review: decidedReview ?? s.review,
        decided: 'accepted',
        jobId: null,
        // Decided: the plan is no longer pending, so its handle goes with the
        // job id rather than lingering as a stale confirm target.
        planId: null,
        approved,
        progress: null,
        errorCode: null,
      }));
      // THE ROW SETTLES IN PLACE (MOTIR-6037; design Part XXII §22.2, § 20's rule). The
      // To-approve list under this overlay is a client island `router.refresh()` cannot
      // reach, so an asked plan's decision travels through the decided-gates store.
      announcePlanGateDecided(review, 'approved');
      approvedCbRef.current?.(approved);
    } catch (err) {
      if (!mountedRef.current) return;
      setState((s) => ({ ...s, phase: 'review', errorCode: planDecisionErrorCode(err) }));
      await rereadAfterRefusal(planId, err);
    }
  }, [rereadAfterRefusal]);

  /**
   * DISCARD the proposal — `POST /api/plans/[id]/decline`, which drops the
   * proposed items and leaves the tree untouched. It writes to the PLAN (so the
   * run is decided rather than left orphaned at `planned`) and never to the tree.
   * The conversation stays open either way.
   */
  const discard = useCallback(
    async (noteMd?: string | null) => {
      const { planId, review } = stateRef.current;
      setState((s) => ({ ...s, phase: 'deciding', errorCode: null }));
      try {
        // The reason is OPTIONAL on a plan's decline (ADR §11.4; MOTIR-6037's confirm band).
        const stamp = review?.gate?.stamp ?? null;
        if (planId) {
          await (noteMd
            ? declinePlanRequest(planId, stamp, noteMd)
            : declinePlanRequest(planId, stamp));
        }
        if (planId) announcePlanGateDecided(review, 'declined');
        if (!mountedRef.current) return;
        setState((s) => ({
          ...s,
          phase: 'idle',
          // The review STAYS (MOTIR-3162). This is the case where nothing survived
          // at all: a discarded plan left the workspace with no trace, so somebody
          // who had just spent ten minutes shaping a tree and decided against it
          // had nothing to look back at before starting the next turn.
          decided: 'declined',
          jobId: null,
          planId: null,
          progress: null,
          errorCode: null,
        }));
      } catch (err) {
        if (!mountedRef.current) return;
        // The proposal is still pending — say so and leave it decidable, rather
        // than clearing a canvas the server still considers awaiting a decision.
        setState((s) => ({
          ...s,
          phase: 'review',
          errorCode: planDecisionErrorCode(err, 'discard'),
        }));
        if (planId) await rereadAfterRefusal(planId, err);
      }
    },
    [rereadAfterRefusal],
  );

  const dismissError = useCallback(() => {
    setState((s) => ({ ...s, errorCode: null, outOfCredits: false }));
  }, []);

  /**
   * WATCH the mailbox drain (Story MOTIR-4054 · MOTIR-4274).
   *
   * ⚠️ A POLL, AND ONLY BECAUSE THERE IS NOTHING TO PUSH. `motir-ai` consumes a
   * turn at a phase boundary and emits NO frame for it; the ids it records land
   * in a `MailboxReport` that never reaches motir-core (the handler returns
   * `{ planDelta, summary }`). So a turn's ABSENCE from the pending set is the
   * only evidence the run took it, and asking is the only way to see it.
   *
   * ⚠️ IT IS BOUNDED BY ITS OWN CONDITION, which is the thing that makes it
   * acceptable rather than a background timer nobody remembers. It runs only
   * while a run is STREAMING and something is UNREAD — so the overwhelmingly
   * common run, the one where nobody typed anything, makes zero requests, and
   * the last read stops it rather than a timeout.
   *
   * If a `folded` frame ever lands upstream, delete this effect and read the
   * frame; nothing else here changes.
   */
  useEffect(() => {
    const unread = state.queued.some((t) => !t.read);
    const jobId = state.jobId;
    if (state.phase !== 'streaming' || !unread || !jobId) return;

    const controller = new AbortController();
    const timer = setInterval(() => {
      void (async () => {
        try {
          const delivery = await peekMailbox(
            stateRef.current.session?.id ?? '',
            jobId,
            controller.signal,
          );
          if (!mountedRef.current) return;
          const stillWaiting = new Set(delivery.turns.map((t) => t.id));
          setState((s) => ({
            ...s,
            // Read = no longer waiting. Nothing is removed: the transcript is a
            // record, and a turn the run TOOK is exactly the one worth still
            // seeing — it is why the next level looks the way it does.
            queued: s.queued.map((t) => (stillWaiting.has(t.id) ? t : { ...t, read: true })),
          }));
        } catch {
          /* a failed peek is not a finding: the next tick asks again, and the
             run is unaffected either way. */
        }
      })();
    }, MAILBOX_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [state.phase, state.jobId, state.queued]);

  /**
   * WATCH the plan's gate while it waits on a decision (bug MOTIR-6151).
   *
   * ⚠️ THIS SURFACE ONLY EVER RE-READ A PLAN IT WAS WRITING. A revision lease taken
   * anywhere else left `review.gate.held` exactly as the last read found it, so Approve
   * and Decline stayed live and the press was refused by the door
   * (`PLAN_REVISION_IN_FLIGHT`) — nothing wrong was written, but the reader was offered
   * a decision the plan could not take until they navigated. The page-state contract's
   * client-island rule: this island seeds its own state, so nothing but its own read
   * reaches it.
   *
   * ⚠️ BOUNDED BY ITS OWN CONDITION, like the mailbox watch above. It runs only while a
   * reader could PRESS something — an undecided plan in `review` whose gate is
   * `awaiting` — and a run of this surface's own (`streaming`) or a decision in flight
   * (`deciding`) tears it down, aborting the read in hand, so a late answer never lands
   * over the decision. A hidden tab skips its ticks and catches up on return.
   */
  const gateAwaiting = state.review?.gate?.state === 'awaiting';
  useEffect(() => {
    const planId = state.planId;
    if (state.phase !== 'review' || state.decided !== null || !planId || !gateAwaiting) return;

    const controller = new AbortController();
    const reread = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void (async () => {
        try {
          const fresh = await fetchPlanReview(planId, controller.signal);
          if (!mountedRef.current || controller.signal.aborted) return;
          setState((s) =>
            s.planId === planId && s.phase === 'review' && s.decided === null
              ? { ...s, review: fileReview(s.review, fresh) }
              : s,
          );
        } catch {
          /* a failed read is not a finding: the next tick asks again. */
        }
      })();
    };
    const timer = setInterval(reread, PLAN_GATE_POLL_MS);
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', reread);

    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', reread);
    };
  }, [state.phase, state.decided, state.planId, gateAwaiting]);

  /**
   * END the run (Story MOTIR-4054 · MOTIR-4068).
   *
   * ⚠️ IT DOES NOT END ANYTHING BY ITSELF, and everything about this callback
   * follows from that. It raises a flag in the boundary mailbox; `runWalk` reads
   * it at its NEXT phase boundary and opens no further phase. Between the two the
   * run is still narrating, so this sets `stopping` and nothing else — the
   * terminal `stopped` is written by the SETTLE, when the stream actually ends,
   * which is the only moment the run really is over.
   *
   * The optimistic alternative — flipping straight to `stopped` — is the defect
   * the card names outright: a rail that keeps narrating under a surface that
   * says the run finished is worse than a slow stop.
   *
   * ⚠️ AND IT IS SAFE WHERE THE CLICK IS REDUNDANT. Stopping an already-finished
   * or already-stopped run is a no-op the server answers cleanly, so a run that
   * settles between render and click costs nothing. The one thing this guards is
   * a SECOND raise: `stopping` gates re-entry, and the key is minted per click so
   * a retry of the same click still delivers once.
   */
  const stop = useCallback(async () => {
    const { jobId, phase } = stateRef.current;
    // Nothing to stop, or a stop already in flight. Not an error and not
    // reported as one: the control stays reachable in both states by design.
    if (phase !== 'streaming' || stoppingRef.current) return;

    stoppingRef.current = true;
    setState((s) => ({ ...s, stopping: true }));
    // ⚠️ NO PLAN JOB TO ADDRESS YET (bug MOTIR-7924) — a submit whose job id has
    // not come back, or an ask / debug job the door does not match. The stop is
    // HELD, and the branch that adopts the plan job raises it there; posting the
    // id in hand would be refused and silently undo the click.
    if (!jobId || jobId === unstoppableJobRef.current) {
      pendingStopRef.current = true;
      return;
    }
    await raiseStop(stateRef.current.session?.id ?? '', jobId);
  }, [raiseStop]);

  // `failing` is the poll's own, so it rides on the state it describes.
  const exposed = useMemo(
    () => (state.liveFailing === liveFailing ? state : { ...state, liveFailing }),
    [state, liveFailing],
  );

  /**
   * START A NEW SESSION carrying this ended one's conversation (AMENDMENT 23 §6;
   * MOTIR-7643) — the Start slot's one action. The server copies the turns and
   * sends nothing; the overlay SWAPS onto the new session in place, live, with
   * none of the old run's state carried across (no act record, no failure, no
   * plan). Its own failure is the recoverable session error.
   */
  const startCopied = useCallback(async () => {
    const from = stateRef.current.session;
    if (!from || !sessionEnded(from) || abortRef.current) return;
    try {
      const copied = await startCopiedSession(from.id);
      if (!mountedRef.current) return;
      lastAskTurnRef.current = null;
      setState((s) => ({
        ...s,
        phase: 'idle',
        session: copied,
        progress: null,
        acts: [],
        ...NO_NARRATION,
        review: null,
        liveReview: null,
        discardedReview: null,
        decided: null,
        jobId: null,
        planId: null,
        approved: null,
        errorCode: null,
        outOfCredits: false,
        stopping: false,
        stopped: false,
        queued: [],
        earlier: null,
        reopened: null,
        readOnly: false,
        copyable: null,
        targetHeld: null,
        restartedFrom: null,
      }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!mountedRef.current) return;
      setState((s) => ({ ...s, errorCode: 'SESSION_UNAVAILABLE' }));
    }
  }, []);

  /**
   * PLAN SOMETHING NEW pressed (MOTIR-7650; ADR AMENDMENT 3, A3.3): the server
   * writes the SAME fixed confirm the words produce. Nothing closes here, and a
   * confirm already pending comes back unchanged.
   */
  const requestRestart = useCallback(async () => {
    const session = stateRef.current.session;
    if (!session || sessionEnded(session) || abortRef.current || restartingRef.current) return;
    restartingRef.current = true;
    setState((s) => ({ ...s, restarting: true }));
    try {
      const withConfirm = await requestRestartConfirm(session.id);
      if (!mountedRef.current) return;
      setState((s) => ({ ...s, session: withConfirm, restarting: false }));
    } catch (err) {
      if (!mountedRef.current) return;
      setState((s) => ({
        ...s,
        restarting: false,
        errorCode:
          err instanceof DOMException && err.name === 'AbortError'
            ? s.errorCode
            : 'SESSION_UNAVAILABLE',
      }));
    } finally {
      restartingRef.current = false;
    }
  }, []);

  /**
   * The ANSWER to the confirm. `keep` lands the Keep planning marker and changes
   * nothing else. `confirm` ends the session `restarted` (its cards go back) and
   * SWAPS the overlay onto the new, empty session in place — the shape
   * {@link startCopied} swaps with, plus the ended session's id for the rail's
   * earlier-session line.
   */
  const answerRestartConfirm = useCallback(async (answer: 'confirm' | 'keep') => {
    const session = stateRef.current.session;
    if (!session || sessionEnded(session) || abortRef.current || restartingRef.current) return;
    restartingRef.current = true;
    setState((s) => ({ ...s, restarting: true }));
    try {
      if (answer === 'keep') {
        const kept = await answerRestart(session.id, 'keep');
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, session: kept, restarting: false }));
        return;
      }
      const result = await answerRestart(session.id, 'confirm');
      if (!mountedRef.current) return;
      adoptedSessionRef.current = result.session.id;
      lastAskTurnRef.current = null;
      lastAskAnchorRef.current = null;
      setState((s) => ({
        ...s,
        phase: 'idle',
        session: result.session,
        progress: null,
        acts: [],
        ...NO_NARRATION,
        review: null,
        liveReview: null,
        discardedReview: null,
        decided: null,
        jobId: null,
        planId: null,
        approved: null,
        errorCode: null,
        outOfCredits: false,
        stopping: false,
        stopped: false,
        queued: [],
        earlier: null,
        reopened: null,
        readOnly: false,
        copyable: null,
        targetHeld: null,
        restartedFrom: result.endedSessionId,
        restarting: false,
      }));
      restartedCbRef.current?.(result.session.id);
    } catch (err) {
      if (!mountedRef.current) return;
      setState((s) => ({
        ...s,
        restarting: false,
        errorCode:
          err instanceof DOMException && err.name === 'AbortError'
            ? s.errorCode
            : 'SESSION_UNAVAILABLE',
      }));
    } finally {
      restartingRef.current = false;
    }
  }, []);

  /**
   * ANSWER A PLAN OFFER (Story MOTIR-9219 · MOTIR-9294) — or a log-a-bug offer
   * (MOTIR-9324), through the same doors: the offer row's Confirm or Decline, one post
   * per press. The doors decide everything — whether the start
   * runs here, on the target's conversation, or after ending a plan in progress —
   * and the hook only follows: the conversation is REFETCHED, never read from the
   * answer's body, so the refetched offer is what flips the row to confirmed or
   * declined.
   *
   * A confirm whose start landed on ANOTHER conversation (a targeted offer, or the
   * mid-planning restart's successor) swaps the overlay onto it in place, the way
   * Plan something new does, and then follows the new run. A refusal is recorded on
   * the offer's turn and the in-flight id cleared.
   */
  const answerOffer = useCallback(
    async (turnId: string, answer: 'confirm' | 'decline') => {
      const session = stateRef.current.session;
      if (!session || sessionEnded(session) || stateRef.current.readOnly) return;
      if (offerAnsweringRef.current) return;
      offerAnsweringRef.current = true;
      setState((s) => ({ ...s, offerAnsweringTurnId: turnId, offerRefusal: null }));
      try {
        if (answer === 'decline') {
          await answerPlanOffer(session.id, turnId, 'decline');
          const read = await getPlanChangeSession(session.id);
          if (!mountedRef.current) return;
          setState((s) => (s.session?.id === read.id ? { ...s, session: read } : s));
          return;
        }
        // The run in flight NOW is the one a mid-planning confirm stops. Taken before
        // the awaits: a turn the person sends while they are out puts its own
        // controller on `abortRef`, and aborting that one dropped the turn (MOTIR-9409).
        const inFlight = abortRef.current;
        const started = await answerPlanOffer(session.id, turnId, 'confirm');
        // A `log_bug` offer (MOTIR-9323) made its one write: no run follows, and the
        // thread the door answered already carries the landing on the offer's turn.
        if (started.kind === 'log_bug') {
          if (!mountedRef.current) return;
          const landed = started.session;
          setState((s) => (s.session?.id === landed.id ? { ...s, session: landed } : s));
          return;
        }
        const read = await getPlanChangeSession(started.sessionId);
        if (!mountedRef.current) return;
        // The run in flight (a mid-planning confirm) was stopped by the door; its
        // stream stops being followed here before the new one is.
        inFlight?.abort();
        if (abortRef.current === inFlight) abortRef.current = null;
        if (read.id !== session.id) {
          adoptedSessionRef.current = read.id;
          lastAskTurnRef.current = null;
          lastAskAnchorRef.current = null;
          setState((s) => ({
            ...s,
            session: read,
            review: null,
            liveReview: null,
            discardedReview: null,
            decided: null,
            planId: null,
            earlier: null,
            reopened: null,
            readOnly: false,
            copyable: null,
            targetHeld: null,
            stalePlan: null,
            offerAnsweringTurnId: null,
          }));
          restartedCbRef.current?.(read.id);
        } else {
          setState((s) => ({ ...s, offerAnsweringTurnId: null }));
        }
        // The answer is in; what follows is the run, which owns its own state.
        offerAnsweringRef.current = false;
        await run(null, async () => ({
          jobId: started.jobId,
          ...(started.planId ? { planId: started.planId } : {}),
          session: read,
        }));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, offerRefusal: { turnId, code: offerRefusalCodeOf(err) } }));
      } finally {
        offerAnsweringRef.current = false;
        if (mountedRef.current) setState((s) => ({ ...s, offerAnsweringTurnId: null }));
      }
    },
    [run],
  );
  const confirmPlanOffer = useCallback(
    (turnId: string) => answerOffer(turnId, 'confirm'),
    [answerOffer],
  );
  const declinePlanOffer = useCallback(
    (turnId: string) => answerOffer(turnId, 'decline'),
    [answerOffer],
  );

  return {
    state: exposed,
    send,
    retry,
    correctTurn,
    approve,
    discard,
    dismissError,
    stop,
    startCopied,
    requestRestart,
    answerRestartConfirm,
    confirmPlanOffer,
    declinePlanOffer,
    planAgain,
    resume,
    answerRunPause,
    showEarlierNarration,
  };
}
