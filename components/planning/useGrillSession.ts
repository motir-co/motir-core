'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SharpenAction } from '@/lib/ai/types';
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
  // Adjusted DURING RENDER (React's derived-state pattern), so the arm and the
  // switch-off mark land in the same frame the switch moved.
  if (on !== prevOn) {
    setPrevOn(on);
    setConvArmedAt(on ? personTurns : null);
    if (!on && session?.status === 'open' && session.scope.kind === 'conversation') {
      setSwitchStopped(session.id);
    }
  }
  const convId = !planId && conversation ? conversation.id : null;
  const offer = convId ? (conversation?.offer ?? null) : null;
  const covered = offer !== null && coversOffer(session, offer);
  const armedForOffer =
    offer !== null && convArmedAt !== null && offer.personTurnsBefore > convArmedAt;
  // Primitives for the effects: the caller builds `offer` afresh every render.
  const hasOffer = offer !== null;
  const offerId = offer?.turnId ?? null;
  const offerGrillable = offer?.grillable ?? false;
  const convEnabled = Boolean(conversation?.enabled);

  // THE ARM: the person-turn count at the moment the mode was turned on (or the
  // mount found it on). A session opens only for a person turn past it.
  const armedAtRef = useRef<number | null>(on ? personTurns : null);
  const prevOnRef = useRef(on);
  // The person-turn count a round was opened at — a later round needs a later turn.
  const roundAtRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const resumeTriedRef = useRef<string | null>(null);
  const openedForOfferRef = useRef<string | null>(null);
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
      if (settled.outcome !== 'pending') {
        setSession(settled.session);
        setError(settled.outcome === 'failed' ? 'failed' : null);
        return;
      }
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
      if (controller.signal.aborted || !mountedRef.current) return;
    }
  }, []);

  /** Run one door call: draw its session, then follow its job. */
  const run = useCallback(
    async (call: () => Promise<SharpenDoorResult>) => {
      busyRef.current = true;
      setPending(true);
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
        if (mountedRef.current) {
          busyRef.current = false;
          setPending(false);
        }
      }
    },
    [follow],
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
    if (open && open.status === 'open') {
      void run(() => sharpenAct(open.id, 'stop'));
    }
  }, [on, personTurns, run]);

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
        if (open.inFlight?.jobId) void follow(open.id, open.inFlight.jobId);
      })
      .catch(() => {
        // Nothing to resume is not an error the person needs to see.
      });
    return () => controller.abort();
  }, [on, active, planId, session, follow]);

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
            void follow(latest.id, latest.inFlight.jobId);
          }
        }
        setReadFor(convId);
      })
      .catch(() => {
        // Nothing to resume is not an error the person needs to see.
        if (mountedRef.current && !controller.signal.aborted) setReadFor(convId);
      });
    return () => controller.abort();
  }, [convId, hasOffer, readFor, follow]);

  // BEFORE PLANNING — OPEN A ROUND: on, over a grillable offer that arrived after the
  // switch, once the latest session is read and none covers it yet.
  useEffect(() => {
    if (!convId || !offerId || !convEnabled || !on || busyRef.current) return;
    if (!offerGrillable || !armedForOffer || readFor !== convId) return;
    if (covered || dismissedOffer === offerId) return;
    if (openedForOfferRef.current === offerId) return;
    openedForOfferRef.current = offerId;
    queueMicrotask(() => void run(() => openSharpen({ conversationId: convId })));
  }, [
    convId,
    offerId,
    convEnabled,
    on,
    offerGrillable,
    armedForOffer,
    readFor,
    covered,
    dismissedOffer,
    run,
  ]);

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
    // Before planning, a round whose open failed has no session to stop: Stop gives
    // up on grilling that offer, and the offer is shown as planned.
    if ((!open || open.status !== 'open') && offerId && !covered) {
      setDismissedOffer(offerId);
      setError(null);
      return;
    }
    if (!open || open.status !== 'open') return;
    // Stop is reachable while an act is in flight: the walk ends at its boundary.
    abortRef.current?.abort();
    void run(() => sharpenAct(open.id, 'stop'));
  }, [run, offerId, covered]);

  const retry = useCallback(() => {
    const open = sessionRef.current;
    // Before planning, an open that failed is tried again as the open itself.
    if (convId && offerId && !covered && !busyRef.current) {
      void run(() => openSharpen({ conversationId: convId }));
      return;
    }
    if (!open || busyRef.current) return;
    const turnId = failedPersonTurnId(open) ?? open.inFlight?.turnId ?? null;
    if (!turnId) return;
    void run(() => resubmitSharpen(open.id, turnId));
  }, [run, convId, offerId, covered]);

  // THE HOLD, derived every render so Stop, the switch, a reload and the lease need
  // no bookkeeping of their own: a session over the offer holds it while open and
  // shows it once ended; before one opens, an armed grillable offer is held.
  const hold: OfferHold =
    offer === null
      ? null
      : covered
        ? session!.status === 'open'
          ? 'held'
          : 'shown'
        : convEnabled && on && offerGrillable && armedForOffer && dismissedOffer !== offerId
          ? 'held'
          : null;

  return {
    session,
    pending,
    error,
    act,
    stop,
    retry,
    hold,
    endedBySwitch: session !== null && switchStopped === session.id,
  };
}
