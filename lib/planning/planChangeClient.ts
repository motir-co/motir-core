import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import {
  finishedCardsOf,
  PlanAgainNotAvailableClientError,
  PlanSessionPlanDecidedClientError,
  PlanSessionPlanStaleClientError,
} from '@/lib/planning/planSessionClientErrors';

export type { StalePlanFinishedCard } from '@/lib/planning/planSessionClientErrors';
import type {
  CopyableSessionDto,
  DebugLandingDto,
  PlanChangeRunPauseDto,
  EarlierSessionDto,
  PlanChangeSessionDto,
  PlanSessionRestartResultDto,
  PlanTargetHeldByDto,
  ResumableSessionDto,
} from '@/lib/dto/planChange';
import type { PlanSessionListPageDto } from '@/lib/dto/planSessions';

// Client reads/writes for the plan-change CONVERSATION seam (Story 7.30 ·
// MOTIR-1728's routes), consumed by the conversational rail (MOTIR-1730). No
// client component calls the service layer — every call here is an HTTP hop to
// the shipped `/api/ai/plan-change/session*` endpoints.
//
// The JOB half is deliberately NOT re-implemented: a submitted conversation
// returns an ordinary `augment` job id, which the rail streams through the
// ALREADY-SHIPPED `planEditsClient.streamAugmentJob`, and a `planId`, whose
// proposals it reads + confirms through the shipped `planReviewClient`
// (MOTIR-1746). This module owns only the three session calls, and reuses
// `PlanEditsClientError` so a caller branches on one error type (its
// `isOutOfCredits` covers the 402 the submit path can raise).

/**
 * What a submit RESPONSE looks like to the browser. It mirrors the server's
 * `PlanChangeSubmitResultDto` with ONE deliberate difference: `planId` — the
 * `generating` Plan the job's proposals append into (MOTIR-1743/1745) — is
 * OPTIONAL here, exactly as `planEditsClient`'s `PlanEditSubmitResponse` types
 * it. It is an additive echo, so a caller must not depend on it: an E2E stub, a
 * hand-rolled fixture, or a pre-1745 response carries only `jobId`. Read it
 * defensively; the server DTO stays required, since the service always has one.
 */
export interface PlanChangeSubmitResponse {
  jobId: string;
  planId?: string;
  session: PlanChangeSessionDto;
}

/** The anchored submit's response — the above plus the thread's own id, which the
 *  anchored caller needs because it did not open the session in a separate call. */
export interface ContextualPlanResponse extends PlanChangeSubmitResponse {
  sessionId: string;
}

/** The anchored RESUME's response. `session` is `null` for an item never planned;
 *  `planId` names the thread's still-undecided proposal, and is absent whenever
 *  there is nothing pending to confirm — same defensive optionality as above. */
export interface ContextualSessionResumeResponse {
  session: PlanChangeSessionDto | null;
  planId?: string | null;
  /** The scope's earlier conversation when nothing resumed (MOTIR-6024). */
  earlier?: EarlierSessionDto | null;
  /** The caller's own failed / idle-closed session of the scope (AMENDMENT 23 §6). */
  copyable?: CopyableSessionDto | null;
  /** Another holder of one of the scope's cards (AMENDMENT 23 §4). */
  heldBy?: PlanTargetHeldByDto | null;
}

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' } as const;

/** A refusal's code AND its body — the body carries what a lock refusal says
 *  about its holder (AMENDMENT 23 §4). */
async function readError(res: Response): Promise<{ code: string | null; body: unknown }> {
  try {
    const body = (await res.json()) as { code?: string };
    return { code: body?.code ?? null, body };
  } catch {
    return { code: null, body: null };
  }
}

/** The typed refusal for a failed response, its body kept — narrowed to its own
 *  class for the codes a caller follows rather than shows (MOTIR-7932). */
async function clientError(res: Response): Promise<PlanEditsClientError> {
  const { code, body } = await readError(res);
  const b = (body ?? {}) as Record<string, unknown>;
  switch (code) {
    case 'PLAN_SESSION_PLAN_STALE':
      return new PlanSessionPlanStaleClientError(
        res.status,
        body,
        typeof b.planId === 'string' ? b.planId : '',
        finishedCardsOf(b.finishedCards),
      );
    case 'PLAN_SESSION_PLAN_AGAIN_NOT_AVAILABLE':
      return new PlanAgainNotAvailableClientError(
        res.status,
        body,
        typeof b.reason === 'string' ? b.reason : 'superseded',
        typeof b.latestPlanId === 'string' ? b.latestPlanId : null,
      );
    case 'PLAN_SESSION_PLAN_DECIDED':
      return new PlanSessionPlanDecidedClientError(
        res.status,
        body,
        typeof b.planId === 'string' ? b.planId : null,
        typeof b.planStatus === 'string' ? b.planStatus : null,
      );
    default:
      return new PlanEditsClientError(res.status, code, body);
  }
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (!res.ok) throw await clientError(res);
  return (await res.json()) as T;
}

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw await clientError(res);
  return (await res.json()) as T;
}

/** The caller's own RESUMABLE project-wide conversation — their session
 *  that is still OPEN (AMENDMENT 23 §3) — or `null` (MOTIR-6023; AMENDMENT 17 §3). A READ:
 *  mounting the rail creates nothing; the first turn does ({@link startPlanChangeSession}). */
export async function findResumableSession(signal?: AbortSignal): Promise<ResumableSessionDto> {
  const body = await get<Partial<ResumableSessionDto> | null>(
    '/api/ai/plan-change/session',
    signal,
  );
  // Read defensively (an E2E stub may answer the older bare shape or nothing).
  return {
    session: body?.session ?? null,
    earlier: body?.earlier ?? null,
    copyable: body?.copyable ?? null,
  };
}

/** One page of the caller's OWN sessions in the active project — the overlay's
 *  History (Story MOTIR-9218 · MOTIR-9306/9307). `cursor` is the previous page's
 *  `nextCursor`; omit it for the first page. */
export async function listOwnSessions(
  cursor: string | null,
  signal?: AbortSignal,
): Promise<PlanSessionListPageDto> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return get<PlanSessionListPageDto>(`/api/ai/plan-change/sessions/history${query}`, signal);
}

/** START a new session that CARRIES OVER an ended one's conversation (AMENDMENT
 *  23 §6; MOTIR-7643) — the overlay's **Start a new session**. Sends no turn. */
export async function startCopiedSession(
  fromSessionId: string,
  opts: { body?: string; isAnswer?: boolean; anchorKey?: string | null } = {},
  signal?: AbortSignal,
): Promise<PlanChangeSessionDto> {
  // With `body` this is the CARRY (MOTIR-7930): the new session's first turn, in
  // the same transaction that moves a waiting plan into it. The answer may be the
  // caller's OPEN session instead (`takenBack: true`), with the turn already in it.
  return post<PlanChangeSessionDto>(
    '/api/ai/plan-change/session',
    {
      copyFrom: fromSessionId,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.isAnswer ? { isAnswer: true } : {}),
      ...(opts.anchorKey ? { anchorKey: opts.anchorKey } : {}),
    },
    signal,
  );
}

/** The restart door (MOTIR-7650; A3.3): `confirm` ends the session `restarted`
 *  and returns the NEW empty session to swap to — what the Plan something new
 *  dialog's confirm posts (MOTIR-11261) and what a confirm turn already on the
 *  thread posts; `keep` answers such a turn with its marker and returns the
 *  same session. */
export async function answerRestart(
  sessionId: string,
  answer: 'keep',
  signal?: AbortSignal,
): Promise<PlanChangeSessionDto>;
export async function answerRestart(
  sessionId: string,
  answer: 'confirm',
  signal?: AbortSignal,
): Promise<PlanSessionRestartResultDto>;
export async function answerRestart(
  sessionId: string,
  answer: 'confirm' | 'keep',
  signal?: AbortSignal,
): Promise<PlanChangeSessionDto | PlanSessionRestartResultDto> {
  return post('/api/ai/plan-change/session/restart', { sessionId, answer }, signal);
}

/** What the plan offer's Confirm answers (MOTIR-9291): the run it started — on the
 *  conversation `sessionId` names, which may not be the one on screen. */
export type PlanOfferConfirmResponse =
  | {
      kind?: 'plan';
      sessionId: string;
      jobId: string;
      planId?: string;
    }
  /** A `log_bug` offer (MOTIR-9323): its one write landed; no run follows. */
  | { kind: 'log_bug'; sessionId: string; landing: DebugLandingDto; session: PlanChangeSessionDto };

/** The ANSWER to a plan offer on an answer turn (Story MOTIR-9219 · MOTIR-9294): one
 *  post per press. `confirm` starts the offer's plan exactly once; `decline` records
 *  the decision and plans nothing. A refusal throws with the door's code (and, for a
 *  refused start, its `reason` in the body). */
export async function answerPlanOffer(
  sessionId: string,
  offerTurnId: string,
  answer: 'confirm',
  signal?: AbortSignal,
): Promise<PlanOfferConfirmResponse>;
export async function answerPlanOffer(
  sessionId: string,
  offerTurnId: string,
  answer: 'decline',
  signal?: AbortSignal,
): Promise<PlanChangeSessionDto>;
export async function answerPlanOffer(
  sessionId: string,
  offerTurnId: string,
  answer: 'confirm' | 'decline',
  signal?: AbortSignal,
): Promise<PlanOfferConfirmResponse | PlanChangeSessionDto> {
  return post(`/api/ai/plan-change/session/offer/${answer}`, { sessionId, offerTurnId }, signal);
}

/** One conversation BY ID — a reopened session (the Plans page's row). */
export async function getPlanChangeSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<PlanChangeSessionDto> {
  return get<PlanChangeSessionDto>(
    `/api/ai/plan-change/session?id=${encodeURIComponent(sessionId)}`,
    signal,
  );
}

/** START a project-wide conversation with its FIRST TURN — or land that turn on
 *  the caller's resumable one, which the server decides under a lock (§1, §3). */
export async function startPlanChangeSession(
  body: string,
  signal?: AbortSignal,
  isAnswer = false,
): Promise<PlanChangeSessionDto> {
  return post<PlanChangeSessionDto>('/api/ai/plan-change/session', { body, isAnswer }, signal);
}

/** Append ONE turn. Appending ACCUMULATES; it does not submit.
 *
 *  `isAnswer` (MOTIR-2226) says the turn was sent from the answer bar, in reply
 *  to the planner's pending question — which is what lets the transcript later
 *  distinguish a question that was ANSWERED from one that was superseded. */
/**
 * ⚠️ NO LONGER THE COMPOSER'S PATH (MOTIR-1343). Since the ask door landed, a
 * turn on the PROJECT thread is appended by the server inside
 * `POST /api/ai/ask` — one door, one place the intent is resolved. Appending
 * here and submitting separately would write a turn the classifier never saw,
 * which is the mode returning as a code path rather than as a control.
 *
 * Kept because the route it wraps is shipped and still serves replays; do not
 * wire it back into the composer.
 */
export async function appendPlanChangeTurn(
  sessionId: string,
  body: string,
  signal?: AbortSignal,
  isAnswer = false,
): Promise<PlanChangeSessionDto> {
  return post<PlanChangeSessionDto>(
    '/api/ai/plan-change/session/turns',
    { sessionId, body, isAnswer },
    signal,
  );
}

/** Record the PLANNER's turn for a settled job (MOTIR-2226) — the report it owes
 *  on every turn, plus the question when it asked. Safe to call more than once
 *  for one job: the server keys the append on the job id, so a replay returns the
 *  same thread rather than a duplicate bubble. */
export async function recordPlannerTurn(
  sessionId: string,
  jobId: string,
  anchor: { anchorId: string; targetKeys: readonly string[] } | null,
  signal?: AbortSignal,
): Promise<PlanChangeSessionDto> {
  return post<PlanChangeSessionDto>(
    '/api/ai/plan-change/session/planner-turn',
    anchor
      ? { sessionId, jobId, anchorId: anchor.anchorId, targetKeys: [...anchor.targetKeys] }
      : { sessionId, jobId },
    signal,
  );
}

/** Submit the conversation's ACCUMULATED intent — every user turn in order, not
 *  just the newest one. Returns the shipped `augment` job to stream + approve. */
export async function submitPlanChange(
  sessionId: string,
  signal?: AbortSignal,
  /** `planAgainOf` — the STALE plan whose Plan it again this is (MOTIR-7945). */
  opts: { planAgainOf?: string } = {},
): Promise<PlanChangeSubmitResponse> {
  return post<PlanChangeSubmitResponse>(
    '/api/ai/plan-change/session/submit',
    { sessionId, ...(opts.planAgainOf ? { planAgainOf: opts.planAgainOf } : {}) },
    signal,
  );
}

/**
 * RESUME a failed hosted planning session (Story MOTIR-7905 · MOTIR-7916): the owner's own
 * failed-waiting session continues on the SAME plan in the SAME session. Returns the new job to
 * stream (through the relay that session already uses), the plan, and the session as it now
 * stands. One door for both Resume buttons — the To resume entry and the overlay.
 *
 * A refusal rejects with the shared client error, whose `code` is the typed one
 * (`NOT_SESSION_OWNER`, `SESSION_NOT_FAILED`, `PLAN_NOT_RESUMABLE`, `RESUME_ALREADY_STARTED`, …).
 * On `RESUME_ALREADY_STARTED` the body carries the WINNING attempt's `jobId`
 * ({@link resumeAlreadyStartedJobId}), so a double-click streams the one that is running.
 */
export async function resumePlanSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<PlanChangeSubmitResponse> {
  return post<PlanChangeSubmitResponse>(
    '/api/ai/plan-change/session/resume',
    { sessionId },
    signal,
  );
}

/** The job a `RESUME_ALREADY_STARTED` refusal names, or null for any other error. */
export function resumeAlreadyStartedJobId(err: unknown): string | null {
  if (!(err instanceof PlanEditsClientError) || err.code !== 'RESUME_ALREADY_STARTED') return null;
  const jobId = (err.body as { jobId?: unknown } | null)?.jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
}

// ─── The BOUNDARY MAILBOX — reaching a run that is already going ─────────────
//
// The submit door above STARTS a run. These reach one already in flight, through
// the store MOTIR-4067 shipped, at the phase boundary `runWalk` already has.

/** What one boundary check finds — motir-ai's own shape, mirrored back to the
 *  client so the composer can say how much is still queued. */
export interface MailboxDeliveryResponse {
  turns: Array<{
    id: string;
    text: string;
    receivedAt: string;
    disposition: 'fold' | 'restart';
    target: string | null;
  }>;
  stopped: boolean;
}

/**
 * ATTACH one turn to the RUNNING job (Story MOTIR-4054 · MOTIR-4274).
 *
 * ⚠️ THIS IS NOT `submitPlanChange`, AND THE CHOICE IS THE RUN'S PHASE. Outside a
 * run a turn is appended and submitted, which STARTS a job; during a run it goes
 * here, which starts nothing. Sending a mid-run turn down the submit path would
 * open a SECOND planning job on a thread that already has one, and sending a
 * between-runs turn here would put it in a box nothing will ever check. Both
 * failures are silent, which is why the branch lives in one place.
 *
 * ⚠️ `idempotencyKey` IS PER SEND, not per render. The door REQUIRES one and
 * refuses without it, so a double-click or a retry of the same click delivers
 * once — but a genuinely new sentence must carry a new key or it is swallowed as
 * a replay of the last one.
 */
export async function attachMidRunTurn(
  sessionId: string,
  jobId: string,
  body: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<MailboxDeliveryResponse> {
  return post<MailboxDeliveryResponse>(
    '/api/ai/plan-change/session/mailbox',
    { sessionId, jobId, body, idempotencyKey },
    signal,
  );
}

/**
 * WHAT IS STILL WAITING for the run — the read that lets the composer say a
 * queued turn has been taken (Story MOTIR-4054 · MOTIR-4274).
 *
 * ⚠️ A POLL, because there is nothing to push. `motir-ai` consumes a turn at a
 * phase boundary and emits no frame for it, and the ids it records never reach
 * motir-core, so absence from this answer is the only evidence a turn was read.
 * The caller keeps it bounded: it asks only while a run is streaming AND
 * something is queued, so an ordinary run makes no requests at all.
 */
export async function peekMailbox(
  sessionId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<MailboxDeliveryResponse> {
  const res = await fetch(
    `/api/ai/plan-change/session/mailbox?jobId=${encodeURIComponent(jobId)}&sessionId=${encodeURIComponent(sessionId)}`,
    { headers: JSON_HEADERS, signal },
  );
  if (!res.ok) throw await clientError(res);
  return (await res.json()) as MailboxDeliveryResponse;
}

/**
 * END the run (Story MOTIR-4054 · MOTIR-4068).
 *
 * ⚠️ `idempotencyKey` IS THE CALLER'S, and it is per-CLICK rather than per-render:
 * a double-clicked Stop must raise ONE stop, and the server cannot recognise the
 * second request as the same act unless the client says so. Reuse the key across
 * a retry of the SAME click; mint a new one for a new one.
 *
 * ⚠️ IT RETURNS AS SOON AS THE FLAG IS STORED. The run ends when the walk READS it:
 * motir-ai's mid-run inbox polls the mailbox on its own timer (the 5 s throttle) and,
 * on reading the stop, aborts every author session in flight at once — the job ends
 * within 15 s of the stop's row, not at the next phase boundary (MOTIR-11191). Work
 * items already written are kept; one a session was cut off writing keeps its laid
 * title and boundary and the briefing names it as not written. So a resolved promise
 * here still means *the stop is recorded*, never *the run is over*, and the surface
 * keeps saying "stopping" until the stream actually ends — now a few seconds, not a
 * level of sessions. A START OVER is unchanged: it is still held for the boundary.
 */
export async function stopPlanChangeRun(
  sessionId: string,
  jobId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<MailboxDeliveryResponse> {
  return post<MailboxDeliveryResponse>(
    '/api/ai/plan-change/session/mailbox/stop',
    { sessionId, jobId, idempotencyKey },
    signal,
  );
}

// ─── The ASK door — one entrance for every turn on the PROJECT thread ─────────
//
// `POST /api/ai/ask` is not an "ask-only" endpoint the client picks when it
// already knows (MOTIR-1819 · `docs/decisions/conversation-turn-intent.md` §2).
// The person types into one composer with no mode to flip, so these helpers send
// the TEXT and never an intent — what the turn turns out to be comes BACK, and a
// plan-change request is handed off to the shipped submit by the server.
//
// ⚠️ NOTHING HERE MAY GROW AN `intent` ARGUMENT. A hint on the wire is the mode
// the design deliberately does not have, re-entering through the back door (ADR
// §5), and `tests/ai/askRoutes.test.ts` asserts the server ignores one.

/** What the ask door returns for a submitted or re-run turn: the job to stream,
 *  the turn the settle keys on, and the thread as the server now has it. */
export interface AskSubmitResponse {
  jobId: string;
  turnId: string;
  session: PlanChangeSessionDto;
}

/** What a settled ask job produced — exactly one of three, rendered differently.
 *  `redirected` is the two-stream hand-off: the turn was a plan change, and
 *  `jobId` / `planId` name the plan-edit job now running (ADR Consequence 3). */
export type AskSettleResponse =
  | { outcome: 'answered'; session: PlanChangeSessionDto }
  | { outcome: 'redirected'; jobId: string; planId: string; session: PlanChangeSessionDto }
  // A MID-RUN turn (MOTIR-7996) read as a change: forwarded to the running job.
  | { outcome: 'forwarded'; delivery: MailboxDeliveryResponse; session: PlanChangeSessionDto }
  // …but the run had ended. Nothing was written; `text` goes back to the composer.
  | {
      outcome: 'forward_refused';
      code: string;
      jobStatus: string;
      text: string;
      session: PlanChangeSessionDto;
    }
  // …or the walk was over and the plan not yet decided (MOTIR-7997): the change
  // became ONE revision of the run's plan. `text` is the forwarded body.
  | {
      outcome: 'revised_late';
      planId: string;
      revisionJobId: string;
      text: string;
      session: PlanChangeSessionDto;
    }
  | { outcome: 'silent'; session: PlanChangeSessionDto };

/**
 * A turn that opened NO ask job — it went straight to the shipped plan-change
 * submit, and `jobId` / `planId` name the plan-edit job now running.
 *
 * It arrives from either entrance, and the caller must handle it from both:
 * a NEW turn that answers the planner's pending question (the affordance already
 * settled the disposition, so there is nothing to classify), and a RE-RUN the
 * handler hands back.
 */
export interface AskRedirectResponse {
  outcome: 'redirected';
  jobId: string;
  planId: string;
  session: PlanChangeSessionDto;
}

/** Send a NEW user turn through the one door. The body carries the text alone. */
export async function submitAskTurn(
  body: string,
  signal?: AbortSignal,
  /** Whether the composer's ANSWER affordance sent this turn — ADR §1's wire
   *  field. It is not an intent: it records which affordance sent the turn, so
   *  the thread can say later whether the planner's question was answered or
   *  merely superseded, AND — when the thread really is waiting on a question —
   *  it is what sends the turn straight to the plan-change submit instead of
   *  through a classifier that has nothing useful to decide. */
  isAnswer = false,
  /** The conversation the rail holds (MOTIR-6023). Absent on a first turn,
   *  which starts the session. */
  sessionId: string | null = null,
  /** A PICK's project-anchored first turn (MOTIR-6435): the gate it is seeded
   *  from, so the session it starts is stamped and the door can return to it.
   *  Rides only when there is no `sessionId`; a gate that may not seed the project
   *  scope answers `422 SEED_NOT_APPLICABLE`. */
  seedGateId: string | null = null,
  /** The ONE work item this turn is ABOUT (MOTIR-7047 · ADR AMENDMENT 1, A1.2) —
   *  the triage bug the report widget just filed, on its seeded debug turn
   *  (MOTIR-7050). DATA, not an intent: the turn still lands on the project-wide
   *  thread, and what it turns out to be is still the server's reading. */
  anchorKey: string | null = null,
): Promise<AskSubmitResponse | AskRedirectResponse> {
  return post<AskSubmitResponse | AskRedirectResponse>(
    '/api/ai/ask',
    {
      body,
      isAnswer,
      ...(sessionId ? { sessionId } : {}),
      ...(seedGateId && !sessionId ? { seedGateId } : {}),
      ...(anchorKey ? { anchorKey } : {}),
    },
    signal,
  );
}

/** The planner's mid-run pause, as the rail reads it (MOTIR-8007). */
export type RunPauseResponse = PlanChangeRunPauseDto;

export type AnswerRunPauseResponse =
  | { outcome: 'answered'; pause: PlanChangeRunPauseDto; delivery: MailboxDeliveryResponse }
  | {
      outcome: 'refused';
      code: string;
      jobStatus: string;
      choice: 'start_over' | 'apply' | 'reply' | 'resume';
      text?: string;
      pause: PlanChangeRunPauseDto;
    };

/** The session's latest pause on this run, or `null` — the rail polls it while the
 *  run is paused (MOTIR-8007). */
export async function readRunPause(
  sessionId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<RunPauseResponse | null> {
  return get<RunPauseResponse | null>(
    `/api/ai/plan-change/session/run-pause?sessionId=${encodeURIComponent(sessionId)}&jobId=${encodeURIComponent(jobId)}`,
    signal,
  );
}

/** Answer the planner's pause: START OVER or apply-to-written on a replan, a typed
 *  reply on an unclear one (MOTIR-8007). A run that ended first answers `refused`
 *  with the choice (and reply text) to hand back. */
export async function answerRunPause(
  sessionId: string,
  jobId: string,
  pauseId: string,
  choice: 'start_over' | 'apply' | 'reply' | 'resume',
  text?: string,
  signal?: AbortSignal,
): Promise<AnswerRunPauseResponse> {
  return post<AnswerRunPauseResponse>(
    '/api/ai/plan-change/session/run-pause',
    { sessionId, jobId, pauseId, choice, ...(text !== undefined ? { text } : {}) },
    signal,
  );
}

/** What {@link submitLateChanges} answers (MOTIR-7997). */
export type LateChangesResponse =
  | { outcome: 'none' }
  | { outcome: 'revised'; planId: string; revisionJobId: string; texts: string[] }
  | { outcome: 'refused'; code: string; texts: string[]; planStatus?: string };

/**
 * Turn the changes STRANDED in a finished run's mailbox into ONE revision of its
 * plan (MOTIR-7997). Called once when a planning run's stream ends and the rail
 * still lists a forwarded turn it never saw read. A `refused` answer carries every
 * claimed text, to hand back to the person.
 */
export async function submitLateChanges(
  sessionId: string,
  runJobId: string,
  signal?: AbortSignal,
): Promise<LateChangesResponse> {
  return post<LateChangesResponse>(
    '/api/ai/plan-change/session/late-changes',
    { sessionId, runJobId },
    signal,
  );
}

/**
 * Send a turn typed WHILE a planning run is in progress (MOTIR-7996). It is NOT
 * the mailbox: it goes to the answering session with a run snapshot, and only a
 * change verdict is forwarded to the run (at settle). The response is an ordinary
 * ask submit — stream and settle its `jobId` like any ask, on its own controller.
 */
export async function submitMidRunAskTurn(
  sessionId: string,
  runJobId: string,
  planId: string,
  body: string,
  signal?: AbortSignal,
): Promise<AskSubmitResponse> {
  return post<AskSubmitResponse>('/api/ai/ask', { body, sessionId, runJobId, planId }, signal);
}

/**
 * RE-RUN a turn that is already on the thread — no second user turn is appended,
 * because the person said one thing once (ADR §3).
 *
 * `flip` distinguishes the two callers: absent is the retry after a failed run,
 * `true` is the correction affordance. The DIRECTION of a flip is derived
 * server-side from what the turn ran as, so this names the turn and never the
 * intent.
 */
export async function rerunAskTurn(
  turnId: string,
  /** `anchorKey` is the anchor the turn was FIRST sent with (MOTIR-7050), so the
   *  re-read is about the same work item the first one was. */
  options: { flip?: boolean; sessionId?: string | null; anchorKey?: string | null } = {},
  signal?: AbortSignal,
): Promise<AskSubmitResponse | AskRedirectResponse> {
  return post<AskSubmitResponse | AskRedirectResponse>(
    '/api/ai/ask',
    {
      turnId,
      ...(options.flip ? { flip: true } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.anchorKey ? { anchorKey: options.anchorKey } : {}),
    },
    signal,
  );
}

/** File what a finished `ask_project` job produced. Replayable by construction
 *  (the server keys the append on the job id), so a reload or a second tab
 *  calling it again returns the same thread rather than a duplicate bubble. */
export async function settleAskJob(
  jobId: string,
  signal?: AbortSignal,
  sessionId: string | null = null,
): Promise<AskSettleResponse> {
  return post<AskSettleResponse>(
    '/api/ai/ask/settle',
    { jobId, ...(sessionId ? { sessionId } : {}) },
    signal,
  );
}

// ─── The ITEM-ANCHORED half — the MOTIR-909 contextual-planning endpoints ─────
//
// The per-item entrance (MOTIR-910) rides the SAME conversation substrate,
// addressed by its anchor set instead of by the project. The shapes differ in one
// way worth naming: the project thread appends and submits in two calls, while
// the anchored endpoint does BOTH in one (it resolves + view-gates the anchors
// first, so splitting it would gate twice for one turn).

// MULTI-TARGET (MOTIR-1491): the anchor set is the PRIMARY anchor (the path
// item) plus the ADDITIONAL ones the `@`-mention picker inserted, by identifier.
// The route has accepted `targetKeys` on all three verbs since MOTIR-909 — these
// helpers simply carry them, so the same set that resumes a thread also submits
// and resubmits to it. Omitted / empty is exactly the single-anchor entrance.

const anchorPath = (anchorId: string) => `/api/work-items/${encodeURIComponent(anchorId)}/ai/plan`;

/** The additional anchors, OMITTED when there are none — so a single-anchor
 *  request stays byte-identical to the entrance's (MOTIR-910) and the route's
 *  `undefined` default does the rest. */
function extra(targetKeys: readonly string[]): { targetKeys?: string[] } {
  return targetKeys.length > 0 ? { targetKeys: [...targetKeys] } : {};
}

/** The additional anchors as the GET's repeated `?targetKey=` params. */
function anchorQuery(targetKeys: readonly string[], sessionId: string | null = null): string {
  if (targetKeys.length === 0 && !sessionId) return '';
  const params = new URLSearchParams();
  for (const key of targetKeys) params.append('targetKey', key);
  if (sessionId) params.set('sessionId', sessionId);
  return `?${params.toString()}`;
}

/** The session the anchored caller holds, spread into a body (MOTIR-6023). */
function withSession(sessionId: string | null): { sessionId?: string } {
  return sessionId ? { sessionId } : {};
}

/** RESUME the item's thread on mount. A null `session` means the item was never
 *  planned — a read, so looking at the entrance never writes a session row.
 *
 *  Returns the ENVELOPE rather than the bare session (MOTIR-1745): a resumed
 *  thread may have a proposal still awaiting confirmation, and its `planId` is
 *  what lets the rail address that Plan. Both fields are normalized to `null` so
 *  a response predating the field reads the same as one with nothing pending. */
export async function resumeContextualSession(
  anchorId: string,
  targetKeys: readonly string[] = [],
  signal?: AbortSignal,
  /** A NAMED conversation to reopen; absent, the caller's resumable one. */
  sessionId: string | null = null,
): Promise<ContextualSessionResumeResponse> {
  const res = await fetch(`${anchorPath(anchorId)}${anchorQuery(targetKeys, sessionId)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw await clientError(res);
  const body = (await res.json()) as ContextualSessionResumeResponse;
  return {
    session: body.session ?? null,
    planId: body.planId ?? null,
    earlier: body.earlier ?? null,
    copyable: body.copyable ?? null,
    heldBy: body.heldBy ?? null,
  };
}

/** Append the turn to the item's thread AND submit the accumulated intent — one
 *  call (the MOTIR-909 contract). The Re-plan "reason" IS this prompt.
 *
 *  `seedGateId` (MOTIR-6210) is the REFUSED gate a seeded re-plan starts from. It
 *  rides only when there is no `sessionId` — the first turn — and the server
 *  ignores it otherwise; a gate that may not seed the scope answers
 *  `422 SEED_NOT_APPLICABLE`.
 *
 *  `seedGuideTurnId` (Story MOTIR-8684 · MOTIR-8693) is the GUIDE OFFER's turn a
 *  guide-seeded first turn starts from. Like `seedGateId` it rides only the first turn
 *  (no `sessionId`), and it is NEVER sent together with a gate seed — the two seeds are
 *  exclusive on the session, so this throws rather than send both. The server answers
 *  three refusals the caller must word: `409 GUIDE_REPLAN_OFFER_CONFIRMED { sessionId }`
 *  (the offer already started a session — return to it, send nothing),
 *  `409 GUIDE_REPLAN_OFFER_NOT_OPEN` (declined or superseded) and
 *  `422 SEED_NOT_APPLICABLE` (the scope does not hold the offer's target). */
export async function submitContextualPlan(
  anchorId: string,
  prompt: string,
  targetKeys: readonly string[] = [],
  signal?: AbortSignal,
  isAnswer = false,
  sessionId: string | null = null,
  seedGateId: string | null = null,
  seedGuideTurnId: string | null = null,
): Promise<ContextualPlanResponse> {
  if (seedGateId && seedGuideTurnId) {
    throw new Error('A planning turn is seeded by a gate or a guide offer, never both.');
  }
  return post<ContextualPlanResponse>(
    anchorPath(anchorId),
    {
      prompt,
      isAnswer,
      ...extra(targetKeys),
      ...withSession(sessionId),
      ...(seedGateId && !sessionId ? { seedGateId } : {}),
      ...(seedGuideTurnId && !sessionId ? { seedGuideTurnId } : {}),
    },
    signal,
  );
}

/** Re-send the item thread's ACCUMULATED intent after a failed run, appending
 *  NOTHING — the conversation continues rather than restarting. */
export async function resubmitContextualPlan(
  anchorId: string,
  targetKeys: readonly string[] = [],
  signal?: AbortSignal,
  sessionId: string | null = null,
): Promise<ContextualPlanResponse> {
  return post<ContextualPlanResponse>(
    anchorPath(anchorId),
    { resubmit: true, ...extra(targetKeys), ...withSession(sessionId) },
    signal,
  );
}
