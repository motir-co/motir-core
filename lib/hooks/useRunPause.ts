import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import {
  answerRunPause as answerRunPauseClient,
  readRunPause,
} from '@/lib/planning/planChangeClient';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { MAILBOX_POLL_MS, pauseOf } from '@/lib/planning/runPause';
import type { PlanChangeRunPauseDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// THE PLANNER'S PAUSE, polled and answered (Story MOTIR-7990 · MOTIR-8010).
//
// Split from `usePlanChangeConversation` so that file does not grow by a fifth
// concern. It owns three things and touches none of the run's own state: it never
// reads or writes `jobId`, `phase`, `stopping` or the run's abort controller. A
// *Start over* reaches the walk only as the `restart` mailbox turn the pause door
// writes.

type SetState = Dispatch<SetStateAction<PlanChangeConversationState>>;
type Choice = 'start_over' | 'apply' | 'reply' | 'resume';

/** The answer a 409 carries as the one that STANDS. */
const STORED_ANSWERS = new Set(['start_over', 'apply', 'replied', 'resumed']);

function sameRead(a: PlanChangeRunPauseDto | null, b: PlanChangeRunPauseDto | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useRunPause({
  state,
  stateRef,
  setState,
  mountedRef,
}: {
  state: PlanChangeConversationState;
  stateRef: { readonly current: PlanChangeConversationState };
  setState: SetState;
  mountedRef: { readonly current: boolean };
}) {
  const sessionId = state.session?.id ?? null;
  const jobId = state.jobId;
  // A planning run is working — the only time a pause can be posted or answered.
  const live = state.phase === 'streaming' && state.planId !== null && sessionId && jobId;
  const lastRun = useRef<{ sessionId: string; jobId: string } | null>(null);
  const wasLive = useRef(false);

  const refresh = useCallback(
    async (run: { sessionId: string; jobId: string }, signal?: AbortSignal) => {
      try {
        const pause = await readRunPause(run.sessionId, run.jobId, signal);
        if (!mountedRef.current) return;
        setState((s) => (sameRead(pauseOf(s), pause) ? s : { ...s, runPause: pause }));
      } catch {
        /* a failed read is not a finding: the next tick asks again. */
      }
    },
    [mountedRef, setState],
  );

  // POLL while the run streams, at the mailbox poll's own cadence, and read ONCE
  // more when it ends so an answer that landed in the last tick is not missed.
  useEffect(() => {
    if (!live) {
      if (wasLive.current && lastRun.current) void refresh(lastRun.current);
      wasLive.current = false;
      return;
    }
    const run = { sessionId: sessionId as string, jobId: jobId as string };
    lastRun.current = run;
    wasLive.current = true;
    const controller = new AbortController();
    const timer = setInterval(() => void refresh(run, controller.signal), MAILBOX_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [live, sessionId, jobId, refresh]);

  // A REPLY already delivered when this render began (a reloaded session): hold its
  // mailbox entry in `queued` so the mailbox poll can report it read.
  const pause = pauseOf(state);
  const replyEntry = pause?.answer === 'replied' ? pause.mailboxEntryId : null;
  useEffect(() => {
    if (!live || !replyEntry) return;
    setState((s) =>
      s.queued.some((q) => q.id === replyEntry)
        ? s
        : {
            ...s,
            queued: [...s.queued, { id: replyEntry, text: pause?.replyText ?? '', read: false }],
          },
    );
  }, [live, replyEntry, pause?.replyText, setState]);

  const pendingRef = useRef(false);
  const answerRunPause = useCallback(
    /** `optionId` (MOTIR-11700): a reply that CLICKED one of the question's options;
     *  `text` is then that option's label. */
    async (choice: Choice, text?: string, optionId?: string) => {
      const current = stateRef.current;
      const open = pauseOf(current);
      const run =
        current.session && current.jobId ? { sid: current.session.id, job: current.jobId } : null;
      if (!open || !run || pendingRef.current) return;
      pendingRef.current = true;
      setState((s) => ({ ...s, answeringPause: true, pauseAnswerRefusal: null }));
      try {
        const res = optionId
          ? await answerRunPauseClient(run.sid, run.job, open.id, choice, text, undefined, optionId)
          : await answerRunPauseClient(run.sid, run.job, open.id, choice, text);
        if (!mountedRef.current) return;
        if (res.outcome === 'answered') {
          setState((s) => ({
            ...s,
            runPause: res.pause,
            queued: [
              ...s.queued,
              ...res.delivery.turns
                .filter((t) => !s.queued.some((q) => q.id === t.id))
                .map((t) => ({ id: t.id, text: t.text, read: false })),
            ],
          }));
        } else {
          setState((s) => ({
            ...s,
            runPause: res.pause,
            pauseAnswerRefusal: {
              code: res.code,
              choice: res.choice,
              ...(res.text !== undefined ? { text: res.text } : {}),
            },
          }));
          await refresh({ sessionId: run.sid, jobId: run.job });
        }
      } catch (err) {
        if (!mountedRef.current) return;
        const stored = err instanceof PlanEditsClientError ? storedAnswerOf(err) : null;
        // A second tab answered first: show the record of the answer that STANDS.
        if (stored) setState((s) => ({ ...s, runPause: { ...open, answer: stored } }));
        else setState((s) => ({ ...s, errorCode: 'MAILBOX_FAILED' }));
      } finally {
        pendingRef.current = false;
        if (mountedRef.current) setState((s) => ({ ...s, answeringPause: false }));
      }
    },
    [stateRef, setState, mountedRef, refresh],
  );

  return { answerRunPause };
}

function storedAnswerOf(err: PlanEditsClientError): PlanChangeRunPauseDto['answer'] | null {
  if (err.status !== 409) return null;
  const answer = ((err.body ?? {}) as { answer?: unknown }).answer;
  return typeof answer === 'string' && STORED_ANSWERS.has(answer)
    ? (answer as PlanChangeRunPauseDto['answer'])
    : null;
}
