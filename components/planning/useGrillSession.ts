'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SharpenAction, SharpenQuestion } from '@/lib/ai/types';
import type { SharpenDoorResult, SharpenSessionDto } from '@/lib/dto/sharpen';
import {
  getLatestConversationSharpen,
  getOpenSharpen,
  openSharpen,
  resubmitSharpen,
  settleSharpen,
  sharpenAct,
} from '@/lib/planning/sharpenClient';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';

// THE ROUTE THE "GRILL ME" MODE SWITCHES (Task MOTIR-1101 · Subtask MOTIR-8447).
//
// With Grill me on, the conversation phase's questions come from a Sharpen
// session over the RUN'S OWN plan (the `generating` plan the run is writing —
// MOTIR-8445 made it a target the door admits), driven through the door's own
// browser client (`lib/planning/sharpenClient.ts`). The hook is the only thing
// that calls that client for the rail.
//
// ⚠️ TURNING IT ON STARTS NOTHING. The switch arms the mode at the number of
// person turns the conversation has; a session is opened only once a person turn
// arrives AFTER that (design G2: "Your next message starts the grilling") and the
// run has a plan to grill over. A render, a plan generation or a re-entered phase
// opens nothing. The one read it makes on its own is the GET of an already-open
// session for that plan, so a reload or a re-entered phase resumes where the
// person was without sending anything.
//
// One act at a time: while a turn's job is in flight every act is refused here
// (the door refuses a second one too — SHARPEN_TURN_IN_FLIGHT), except Stop,
// which is always reachable.
//
// BEFORE PLANNING (Story MOTIR-9221 · Subtask MOTIR-9316; design § Grill me before
// planning). Given a `conversation` and no `planId`, the hook grills the
// plan-change conversation itself: a round opens when an answer carrying a plan
// offer arrives after the switch went on, and the offer is HELD until that
// grilling ends. The in-run path is untouched: it reads only `planId` / `active`,
// and the rail runs one instance of this hook for each.

const SETTLE_POLL_MS = 1000;

export type GrillError = 'failed' | 'refused' | 'outOfCredits' | null;

export interface GrillSession {
  /** The session the rail draws, or null before one is opened. */
  session: SharpenSessionDto | null;
  /** A turn's job (or the open itself) is in flight. */
  pending: boolean;
  error: GrillError;
  /** Answer the pending question — one act. */
  act: (
    action: Exclude<SharpenAction, 'start' | 'stop'>,
    opts?: { readingId?: string; text?: string },
  ) => void;
  stop: () => void;
  /** Re-run the turn whose job failed (Try again). */
  retry: () => void;
  /** Before planning: whether the conversation's latest plan offer is HELD while it
   *  is grilled, SHOWN after a grilling over it ended, or neither (null). */
  hold: OfferHold;
  /** The ended session was stopped by switching Grill me off (this tab only). */
  endedBySwitch: boolean;
  /** The grilling over the held offer is ending — a Stop or a switch-off was confirmed,
   *  or it ended and its requirement is not read yet — so the requirement is being
   *  written (MOTIR-11802). The rail draws the writing line in the held notice's place. */
  writing: boolean;
  /** The grilling is over a requirement already shown (MOTIR-11805): Grill me was
   *  switched on while the offer holding it was pending, so it asks only what that
   *  requirement leaves open, and its end updates it. This tab only. */
  overRequirement: boolean;
}

/** The latest plan offer in the conversation, as the before-planning grilling reads it. */
export interface GrillOffer {
  turnId: string;
  /** The answer turn's `createdAt` — a session created at or after it covers it. */
  createdAt: string;
  /** How many person turns came before the answer — it arrived after the arm when
   *  this is past the count the switch was turned on at. */
  personTurnsBefore: number;
  /** An undecided `plan` offer that can start: the only kind a grilling holds. */
  grillable: boolean;
  /** The offer was answered. A decided offer is never held, and its decline ended the
   *  grilling over it (MOTIR-10255). */
  decided?: boolean;
  /** THE READ'S HAND-OFF (MOTIR-11798): a `grill` offer, made because Grill me was on.
   *  It holds no requirement and nothing to confirm, so it is ALWAYS grilled — with the
   *  switch since turned off too, when the grilling ends at once and writes the
   *  requirement (MOTIR-11802 · MOTIR-11803) — and never shown until that ends. */
  handoff?: boolean;
  /** The offer carries a written requirement: switching Grill me on over it grills it
   *  again, at once (MOTIR-11805). */
  requirement?: boolean;
}

export type OfferHold = 'held' | 'shown' | null;

/** A conversation session that began at or after the offer's answer was grilling it. */
export function coversOffer(session: SharpenSessionDto | null, offer: GrillOffer): boolean {
  return (
    session !== null &&
    session.scope.kind === 'conversation' &&
    session.createdAt >= offer.createdAt
  );
}

interface Args {
  /** The person's Grill me choice. */
  on: boolean;
  /** The run's own plan; null until the run has one. */
  planId: string | null;
  /** The run is in its conversation phase (the control is rendered). */
  active: boolean;
  /** How many person turns the plan-change conversation has. */
  personTurns: number;
  /** Before planning: the conversation to grill, its latest plan offer, and whether
   *  a grilling may open there (a non-guide conversation holding no plan). */
  conversation?: { id: string; offer: GrillOffer | null; enabled: boolean } | null;
}

function codeOf(err: unknown): string | null {
  return err instanceof PlanEditsClientError ? (err.code ?? null) : null;
}

function isOutOfCredits(err: unknown): boolean {
  return (
    err instanceof PlanEditsClientError && (err.status === 402 || err.code === 'out_of_credits')
  );
}

/** The session's latest job stopped because the org ran out of credits — a long
 *  read the credit gate ended (MOTIR-10235), told to the person by name. */
export function endedOutOfCredits(session: SharpenSessionDto): boolean {
  const last = session.turns.findLast((t) => t.role === 'planner');
  return last?.outOfCredits === true;
}

/** The person already asked to stop this session: its stop turn is stored. */
export function stopAsked(session: SharpenSessionDto): boolean {
  return session.turns.some((t) => t.role === 'person' && t.action === 'stop');
}

/** The question still waiting on the person — the stored `pendingQuestion` only
 *  while nothing the person said follows the planner turn that asked it.
 *
 *  The server keeps `pendingQuestion` until the NEXT planner turn replaces it, so
 *  for the whole read that follows an answer, a skip, You decide or a stop, the
 *  stored question is one the person has already acted on (MOTIR-10862). A
 *  session with no planner turn yet keeps the stored question as it is. */
export function openQuestion(session: SharpenSessionDto): SharpenQuestion | null {
  if (session.status !== 'open' || !session.pendingQuestion) return null;
  const asked = session.turns.findLastIndex((t) => t.role === 'planner' && !t.failed);
  if (asked < 0) return session.pendingQuestion;
  const actedOn = session.turns.slice(asked + 1).some((t) => t.role === 'person');
  return actedOn ? null : session.pendingQuestion;
}

/** The person turn a failed planner turn answers — the one Try again re-runs. */
function failedPersonTurnId(session: SharpenSessionDto): string | null {
  const turns = session.turns;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]!.failed) {
      for (let j = i - 1; j >= 0; j -= 1) {
        if (turns[j]!.role === 'person') return turns[j]!.id;
      }
      return null;
    }
  }
  return null;
}

export function useGrillSession({
  on,
  planId,
  active,
  personTurns,
  conversation = null,
}: Args): GrillSession {
  const [session, setSession] = useState<SharpenSessionDto | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<GrillError>(null);
  // BEFORE PLANNING: the person-turn count the switch was turned on at, the
  // conversation whose latest session has been read, the offer a Stop gave up on
  // before any session opened, and the session a switch-off stopped.
  const [convArmedAt, setConvArmedAt] = useState<number | null>(on ? personTurns : null);
  const [prevOn, setPrevOn] = useState(on);
  const [readFor, setReadFor] = useState<string | null>(null);
  const [dismissedOffer, setDismissedOffer] = useState<string | null>(null);
  const [switchStopped, setSwitchStopped] = useState<string | null>(null);
  // GRILL ME ON AGAIN (MOTIR-11805): the shown offer whose requirement the switch asked
  // to grill, the person-turn count it was asked at, and the session opened for it.
  // `round` tells one switch-on from the next over the same offer and turn count, so a
  // second re-grilling of a requirement (nothing left to ask, say) opens its own round.
  const [regrill, setRegrill] = useState<{
    offerId: string;
    at: number;
    round: number;
    sessionId: string | null;
  } | null>(null);
  const [regrillRounds, setRegrillRounds] = useState(0);
  // A Stop pressed before the session over a hand-off existed: the session is opened
  // and stopped as soon as it is, so the requirement is still written (MOTIR-11802).
  const [stopOnOpen, setStopOnOpen] = useState<string | null>(null);
  // Adjusted DURING RENDER (React's derived-state pattern), so the arm and the
  // switch-off mark land in the same frame the switch moved.
  const convId = !planId && conversation ? conversation.id : null;
  const offer = convId ? (conversation?.offer ?? null) : null;
  const covered = offer !== null && coversOffer(session, offer);
  if (on !== prevOn) {
    setPrevOn(on);
    setConvArmedAt(on ? personTurns : null);
    if (!on && session?.status === 'open' && session.scope.kind === 'conversation') {
      setSwitchStopped(session.id);
    }
    // On over a pending offer that already holds its requirement: grill THAT offer now
    // (MOTIR-11805) — unless a grilling over it is open already.
    if (
      on &&
      offer !== null &&
      offer.requirement === true &&
      offer.handoff !== true &&
      offer.grillable &&
      offer.decided !== true &&
      conversation?.enabled === true &&
      !(covered && session!.status === 'open')
    ) {
      setRegrill({
        offerId: offer.turnId,
        at: personTurns,
        round: regrillRounds + 1,
        sessionId: null,
      });
      setRegrillRounds(regrillRounds + 1);
      setStopOnOpen(null);
    }
    // Off before that grilling opened: nothing to end — unless its open is in flight,
    // when it is stopped the moment it lands, so the requirement stays its own.
    if (!on && regrill !== null && regrill.sessionId === null) {
      if (pending) setStopOnOpen(regrill.offerId);
      setRegrill(null);
    }
  }
  // A hand-off was made with Grill me on, so it is armed whatever the switch says now.
  const offerHandoff = offer?.handoff === true;
  const armedForOffer =
    offer !== null &&
    (offerHandoff || (convArmedAt !== null && offer.personTurnsBefore > convArmedAt));
  // The switch or a hand-off — either opens the grilling over the offer.
  const grillsOffer = on || offerHandoff;
  // Primitives for the effects: the caller builds `offer` afresh every render.
  const hasOffer = offer !== null;
  const offerId = offer?.turnId ?? null;
  const offerGrillable = offer?.grillable ?? false;
  const offerDecided = offer?.decided ?? false;
  const convEnabled = Boolean(conversation?.enabled);
  // The re-grilling asked for this offer, until the next message.
  const regrillLive = regrill !== null && regrill.offerId === offerId && personTurns <= regrill.at;
  const regrillPending = regrillLive && regrill.sessionId === null && dismissedOffer !== offerId;
  const regrillSession =
    regrillLive && regrill.sessionId !== null && session?.id === regrill.sessionId;

  // THE ARM: the person-turn count at the moment the mode was turned on (or the
  // mount found it on). A session opens only for a person turn past it.
  const armedAtRef = useRef<number | null>(on ? personTurns : null);
  const prevOnRef = useRef(on);
  // The person-turn count a round was opened at — a later round needs a later turn.
  const roundAtRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  // Which run owns `pending`. A Stop aborts the run it supersedes, and that run's end
  // must not clear the pending of the Stop's own run.
  const runSeqRef = useRef(0);
  const stoppingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const resumeTriedRef = useRef<string | null>(null);
  const openedForOfferRef = useRef<string | null>(null);
  // A hand-off grilled with the switch already off ends at once (MOTIR-11803): its
  // ending is the switch's, as a session stopped by the switch is.
  const [openedOff, setOpenedOff] = useState<string | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  /** Poll the settle door until the turn's job ends, then draw what it stored. */
  const follow = useCallback(async (sessionId: string, jobId: string) => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    for (;;) {
      let settled;
      try {
        settled = await settleSharpen(sessionId, jobId, controller.signal);
      } catch (err) {
        if (controller.signal.aborted || !mountedRef.current) return;
        setError(isOutOfCredits(err) ? 'outOfCredits' : 'failed');
        return;
      }
      if (controller.signal.aborted || !mountedRef.current) return;
      // Drawn on every poll, pending too, so the job's notes land as it writes them
      // (MOTIR-10235).
      setSession(settled.session);
      if (settled.outcome !== 'pending') {
        setError(
          settled.outcome === 'failed'
            ? endedOutOfCredits(settled.session)
              ? 'outOfCredits'
              : 'failed'
            : null,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
      if (controller.signal.aborted || !mountedRef.current) return;
    }
  }, []);

  const beginRun = useCallback(() => {
    runSeqRef.current += 1;
    busyRef.current = true;
    setPending(true);
    return runSeqRef.current;
  }, []);

  const endRun = useCallback((seq: number) => {
    if (!mountedRef.current || seq !== runSeqRef.current) return;
    busyRef.current = false;
    setPending(false);
  }, []);

  /** Pick up a job already in flight (a reload, a phase entered again): the session is
   *  as busy as if this tab had sent it, so its notes and its Stop are drawn. */
  const resume = useCallback(
    async (sessionId: string, jobId: string) => {
      const seq = beginRun();
      try {
        await follow(sessionId, jobId);
      } finally {
        endRun(seq);
      }
    },
    [beginRun, endRun, follow],
  );

  /** Run one door call: draw its session, then follow its job. */
  const run = useCallback(
    async (call: () => Promise<SharpenDoorResult>) => {
      const seq = beginRun();
      setError(null);
      try {
        const result = await call();
        if (!mountedRef.current) return;
        setSession(result.session);
        const job = result.jobId ?? result.session.inFlight?.jobId ?? null;
        if (job) await follow(result.session.id, job);
      } catch (err) {
        if (!mountedRef.current) return;
        const code = codeOf(err);
        setError(
          isOutOfCredits(err)
            ? 'outOfCredits'
            : code === 'SHARPEN_TURN_IN_FLIGHT' || code === 'SHARPEN_SESSION_ENDED'
              ? 'refused'
              : 'failed',
        );
      } finally {
        endRun(seq);
      }
    },
    [beginRun, endRun, follow],
  );

  /** One Stop per session: a second one would abort the first's follow and be refused,
   *  leaving nothing to land the stop's job. */
  const stopSession = useCallback(
    (open: SharpenSessionDto) => {
      if (stoppingRef.current || stopAsked(open)) return;
      stoppingRef.current = true;
      abortRef.current?.abort();
      void run(() => sharpenAct(open.id, 'stop')).finally(() => {
        stoppingRef.current = false;
      });
    },
    [run],
  );

  // THE SWITCH. On → arm at today's count. Off while a session is open → Stop
  // (design G4: switching it off while it grills is Stop grilling).
  useEffect(() => {
    if (on === prevOnRef.current) return;
    prevOnRef.current = on;
    if (on) {
      armedAtRef.current = personTurns;
      return;
    }
    armedAtRef.current = null;
    const open = sessionRef.current;
    if (open && open.status === 'open') stopSession(open);
  }, [on, personTurns, stopSession]);

  // RESUME, sending nothing: an open session already on this plan is drawn as it
  // stands (a reload, or the conversation phase entered again).
  useEffect(() => {
    if (!on || !active || !planId || session) return;
    if (resumeTriedRef.current === planId) return;
    resumeTriedRef.current = planId;
    const controller = new AbortController();
    void getOpenSharpen({ planId }, controller.signal)
      .then((open) => {
        if (!mountedRef.current || !open) return;
        setSession((cur) => cur ?? open);
        roundAtRef.current = armedAtRef.current;
        if (open.inFlight?.jobId) void resume(open.id, open.inFlight.jobId);
      })
      .catch(() => {
        // Nothing to resume is not an error the person needs to see.
      });
    return () => controller.abort();
  }, [on, active, planId, session, resume]);

  // OPEN A ROUND: on, in the conversation phase, over the run's plan, for a person
  // turn sent after the switch (and after the last round).
  useEffect(() => {
    if (!on || !active || !planId || busyRef.current) return;
    const armedAt = armedAtRef.current;
    if (armedAt === null || personTurns <= armedAt) return;
    if (roundAtRef.current !== null && personTurns <= roundAtRef.current) return;
    if (session && session.status === 'open') return;
    roundAtRef.current = personTurns;
    // Off the effect's own tick: the open is a request to the door, not a render.
    queueMicrotask(() => void run(() => openSharpen({ planId })));
  }, [on, active, planId, personTurns, session, run]);

  // BEFORE PLANNING — RESUME, sending nothing: the caller's latest session on the
  // conversation, open or ended, read once per conversation that holds an offer. An
  // open one is drawn as it stands; an ended one lists what it settled on the offer.
  useEffect(() => {
    if (!convId || !hasOffer || readFor === convId) return;
    const controller = new AbortController();
    void getLatestConversationSharpen(convId, controller.signal)
      .then((latest) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        if (latest) {
          setSession((cur) => cur ?? latest);
          if (latest.status === 'open' && latest.inFlight?.jobId) {
            void resume(latest.id, latest.inFlight.jobId);
          }
        }
        setReadFor(convId);
      })
      .catch(() => {
        // Nothing to resume is not an error the person needs to see.
        if (mountedRef.current && !controller.signal.aborted) setReadFor(convId);
      });
    return () => controller.abort();
  }, [convId, hasOffer, readFor, resume]);

  // BEFORE PLANNING — OPEN A ROUND: on, over a grillable offer that arrived after the
  // switch, once the latest session is read and none covers it yet.
  useEffect(() => {
    if (!convId || !offerId || !convEnabled || !grillsOffer || busyRef.current) return;
    if (!offerGrillable || !armedForOffer || readFor !== convId) return;
    if (covered || dismissedOffer === offerId) return;
    if (openedForOfferRef.current === offerId) return;
    openedForOfferRef.current = offerId;
    const off = !on;
    queueMicrotask(() => {
      if (off) setOpenedOff(offerId);
      void run(() => openSharpen({ conversationId: convId }));
    });
  }, [
    convId,
    offerId,
    convEnabled,
    grillsOffer,
    on,
    offerGrillable,
    armedForOffer,
    readFor,
    covered,
    dismissedOffer,
    run,
  ]);

  // GRILL ME ON AGAIN — OPEN THE ROUND over the requirement already shown (MOTIR-11805),
  // once the latest session is read. The session it opens is the one this round draws.
  const openRegrill = useCallback(
    (forOffer: string, conversationId: string) =>
      run(async () => {
        const opened = await openSharpen({ conversationId });
        if (mountedRef.current) {
          setRegrill((cur) =>
            cur && cur.offerId === forOffer && cur.sessionId === null
              ? { ...cur, sessionId: opened.session.id }
              : cur,
          );
        }
        return opened;
      }),
    [run],
  );
  const regrillKey = regrillPending && regrill ? `${offerId}:${regrill.at}:${regrill.round}` : null;
  useEffect(() => {
    if (!regrillKey || !convId || !offerId || !on || !convEnabled || busyRef.current) return;
    if (!offerGrillable || offerDecided || readFor !== convId) return;
    if (openedForOfferRef.current === regrillKey) return;
    openedForOfferRef.current = regrillKey;
    queueMicrotask(() => void openRegrill(offerId, convId));
  }, [
    regrillKey,
    convId,
    offerId,
    on,
    convEnabled,
    offerGrillable,
    offerDecided,
    readFor,
    openRegrill,
  ]);

  // A DECLINE ENDS THE GRILLING OVER ITS OFFER, on the server (MOTIR-10255): the session
  // drawn here is read again, so the thread stops offering the question.
  const openSessionId = session?.status === 'open' ? session.id : null;
  useEffect(() => {
    if (!convId || !covered || !offerDecided || !openSessionId) return;
    const controller = new AbortController();
    void getLatestConversationSharpen(convId, controller.signal)
      .then((latest) => {
        if (mountedRef.current && !controller.signal.aborted && latest) setSession(latest);
      })
      .catch(() => {
        // The offer is shown as decided either way; only the thread stays as drawn.
      });
    return () => controller.abort();
  }, [convId, covered, offerDecided, openSessionId]);

  const act = useCallback<GrillSession['act']>(
    (action, opts = {}) => {
      const open = sessionRef.current;
      if (!open || open.status !== 'open' || busyRef.current) return;
      void run(() => sharpenAct(open.id, action, opts));
    },
    [run],
  );

  const stop = useCallback(() => {
    const open = sessionRef.current;
    // Before the re-grilling over a shown requirement opened (Stop is drawn there only
    // once its open failed), Stop gives it up: the requirement stays as it was.
    if (regrillPending) {
      setRegrill(null);
      setError(null);
      return;
    }
    // A HAND-OFF has no offer to show until a grilling over it ends (MOTIR-11802): a
    // Stop before its session exists opens it — or waits for the open in flight — and
    // stops it the moment it is there, so the requirement is written all the same.
    if (offerId && offerHandoff && !covered) {
      setStopOnOpen(offerId);
      setError(null);
      if (convId && !busyRef.current) {
        openedForOfferRef.current = offerId;
        void run(() => openSharpen({ conversationId: convId }));
      }
      return;
    }
    // Before planning, a round whose open failed has no session to stop: Stop gives
    // up on grilling that offer, and the offer is shown as planned.
    if ((!open || open.status !== 'open') && offerId && !covered) {
      setDismissedOffer(offerId);
      setError(null);
      return;
    }
    if (!open || open.status !== 'open') return;
    // Stop is reachable while an act is in flight: the walk ends at its boundary.
    stopSession(open);
  }, [stopSession, offerId, covered, offerHandoff, convId, run, regrillPending]);

  // The Stop asked before the session existed, carried out once it does.
  useEffect(() => {
    if (!stopOnOpen || stopOnOpen !== offerId || !covered) return;
    const open = sessionRef.current;
    if (!open || open.status !== 'open' || stopAsked(open)) return;
    stopSession(open);
  }, [stopOnOpen, offerId, covered, session, stopSession]);

  const retry = useCallback(() => {
    const open = sessionRef.current;
    // Before planning, an open that failed is tried again as the open itself.
    if (regrillPending && convId && offerId) {
      if (!busyRef.current) void openRegrill(offerId, convId);
      return;
    }
    if (convId && offerId && !covered && !busyRef.current) {
      void run(() => openSharpen({ conversationId: convId }));
      return;
    }
    if (!open || busyRef.current) return;
    const turnId = failedPersonTurnId(open) ?? open.inFlight?.turnId ?? null;
    if (!turnId) return;
    void run(() => resubmitSharpen(open.id, turnId));
  }, [run, convId, offerId, covered, regrillPending, openRegrill]);

  // THE HOLD, derived every render so Stop, the switch, a reload and the lease need
  // no bookkeeping of their own: a session over the offer holds it while open and
  // shows it once ended; before one opens, an armed grillable offer is held.
  const hold: OfferHold =
    offer === null
      ? null
      : regrillPending
        ? convEnabled && offerGrillable && !offerDecided
          ? 'held'
          : null
        : covered
          ? session!.status === 'open' && !offerDecided
            ? 'held'
            : 'shown'
          : convEnabled &&
              grillsOffer &&
              offerGrillable &&
              armedForOffer &&
              dismissedOffer !== offerId
            ? 'held'
            : null;

  // THE WRITING STATE (MOTIR-11802): the held offer's grilling is ending, so its
  // requirement is being written — a Stop or a switch-off confirmed, a hand-off grilled
  // with the switch off, or an end whose requirement is not read yet.
  const writing =
    hold === 'held' &&
    offer !== null &&
    !regrillPending &&
    (covered
      ? session!.status === 'ended' || stopAsked(session!) || openedOff === offerId
      : offerHandoff && (!on || stopOnOpen === offerId));

  // Credits ending a read is told from the stored turn, not only from a poll that saw
  // it happen: the person may have been away, or reloaded, when it did (MOTIR-10235).
  const outOfCredits =
    session !== null &&
    session.status === 'open' &&
    !pending &&
    session.inFlight === null &&
    endedOutOfCredits(session);

  return {
    // Until the re-grilling opens, the earlier session over the offer is not its thread.
    session: regrillPending ? null : session,
    pending,
    error: error ?? (outOfCredits ? 'outOfCredits' : null),
    act,
    stop,
    retry,
    hold,
    endedBySwitch:
      session !== null &&
      (switchStopped === session.id || (covered && openedOff !== null && openedOff === offerId)),
    writing,
    overRequirement: regrillPending || regrillSession,
  };
}
