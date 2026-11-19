'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { setPlanChangeGrillMe } from '@/lib/planning/planChangeClient';

// WHERE THE "GRILL ME" CHOICE LIVES (Task MOTIR-1101 · Subtask MOTIR-8447; design
// `design/ai-chat/design-notes.md` § Grill me, G1/G2; stored on the session by Story
// MOTIR-11799 · Subtask MOTIR-11801).
//
// The choice belongs to the PLAN-CHANGE SESSION it was made in, never to the mounted
// rail and never to the person — and it is STORED THERE, on the server
// (`plan_change_session.grill_me`):
//
//   • A reload, another tab and a reopened conversation all read the same switch,
//     because they read the same session.
//   • The planner reads it too: every job the session submits carries it.
//   • A DIFFERENT session starts with it off — a new session is created off.
//
// BEFORE THE SESSION EXISTS (the person turns it on in a fresh overlay, before the
// first message creates the session) the value is held locally, mirrored in
// `sessionStorage` so a reload of the tab keeps it, and the first message carries it
// (`submitAskTurn`'s `grillMe`), so the session is created with it on. When the first
// session id appears, that session ADOPTS the choice: if the session did not come back
// on (it was opened by a door that carries no choice), the hook stores it there. The
// local copy is dropped once adopted, and when the rail unmounts without a session —
// a closed overlay does not hand its choice to the next one.
//
// Setting it on a session is OPTIMISTIC and SEQUENCE-GUARDED: the switch moves at
// once, only the latest request's answer is applied, and a refused write falls back
// to the session's stored value.
//
// Every storage access is guarded: a private window or blocked storage still gets a
// working toggle for the life of the mount.

const PENDING_KEY = 'motir.grillMe.pending';

function readPending(): boolean {
  try {
    return window.sessionStorage.getItem(PENDING_KEY) === 'on';
  } catch {
    return false;
  }
}

function writePending(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(PENDING_KEY, 'on');
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage unavailable: the in-memory value still holds for this mount.
  }
}

/** The session as the switch reads it: its id and its stored value. */
export interface GrillOptInSession {
  id: string;
  /** Absent reads as off (a hand-built thread). */
  grillMe?: boolean;
}

export interface GrillOptIn {
  on: boolean;
  setOn: (on: boolean) => void;
}

/** A value this mount set on a session, shown until the session's read agrees. */
interface Local {
  sessionId: string;
  on: boolean;
  inFlight: boolean;
}

/**
 * The person's Grill me choice for `session` — the plan-change session the run
 * belongs to, or `null` before one exists. The session's stored value, or the choice
 * made before it existed.
 */
export function useGrillOptIn(session: GrillOptInSession | null): GrillOptIn {
  const sessionId = session?.id ?? null;
  const stored = session?.grillMe === true;
  const [pending, setPending] = useState<boolean>(() => (session ? false : readPending()));
  const [local, setLocal] = useState<Local | null>(null);
  // The session the PRE-SESSION choice is stored on (the effect below sends it).
  const [adopting, setAdopting] = useState<string | null>(null);
  const [prevSessionId, setPrevSessionId] = useState<string | null>(sessionId);
  const seq = useRef(0);

  // Adjusted during render ("storing information from previous renders"), so the
  // first paint for a session already shows the right value.
  if (prevSessionId !== sessionId) {
    setPrevSessionId(sessionId);
    // THE FIRST SESSION adopts the choice made before it existed: shown on at once,
    // stored by the effect below unless the session already came back on.
    if (prevSessionId === null && sessionId !== null && pending) {
      setPending(false);
      if (!stored) {
        setLocal({ sessionId, on: true, inFlight: true });
        setAdopting(sessionId);
      }
    }
  }
  // A value this mount wrote is shown until the session's own read AGREES with it —
  // then the session's value leads again, so a later change from another tab shows.
  if (local && (local.sessionId !== sessionId || (!local.inFlight && local.on === stored))) {
    setLocal(null);
  }
  const shown = local && local.sessionId === sessionId ? local.on : stored;

  const write = useCallback((id: string, on: boolean) => {
    const mine = ++seq.current;
    setLocal({ sessionId: id, on, inFlight: true });
    setPlanChangeGrillMe(id, on).then(
      (dto) => {
        if (mine !== seq.current) return;
        setLocal({ sessionId: id, on: dto.grillMe === true, inFlight: false });
      },
      () => {
        // Refused or lost: the session's stored value is the truth again.
        if (mine !== seq.current) return;
        setLocal(null);
      },
    );
  }, []);

  // Store the adopted choice — once per session, though the effect may run again.
  const adoptionSent = useRef<string | null>(null);
  useEffect(() => {
    if (!adopting || adoptionSent.current === adopting) return;
    adoptionSent.current = adopting;
    writePending(false);
    write(adopting, true);
  }, [adopting, write]);

  // Once a session exists the local copy has done its job; and a rail closed before
  // any session existed does not hand its choice on to the next one.
  const hasSession = sessionId !== null;
  useEffect(() => {
    if (hasSession) writePending(false);
  }, [hasSession]);
  useEffect(
    () => () => {
      writePending(false);
    },
    [],
  );

  const setOn = useCallback(
    (on: boolean) => {
      if (!sessionId) {
        writePending(on);
        setPending(on);
        return;
      }
      write(sessionId, on);
    },
    [sessionId, write],
  );

  return { on: sessionId ? shown : pending, setOn };
}
