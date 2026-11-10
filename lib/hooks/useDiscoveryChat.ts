'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { drainSseFrames, unwrapProgressFrame } from '@/lib/ai/sseFrames';
import { toDirectionDocView, type DirectionDocKind } from '@/lib/onboarding/directionDoc';
import { mapRevisions } from '@/lib/onboarding/revisions';
import type { DesignChoiceDTO, PreplanStateDTO } from '@/lib/dto/aiPreplan';
import {
  type DiscoveryState,
  initialDiscoveryState,
  normalizeFrame,
  reduceDiscovery,
} from '@/lib/onboarding/discoveryLoop';

// The client driver for the authed discovery onboarding loop (Subtask 7.3.5 /
// MOTIR-833). It owns ALL the I/O the pure `discoveryLoop` reducer can't:
//   - POST /api/ai/chat { prompt } → { jobId }, then read the SSE stream from
//     /api/ai/chat/:jobId/stream (the 7.3.4 chat seam) frame-by-frame;
//   - GET /api/ai/pre-plan (the 7.3.70 read seam, bodies threaded by 7.3.73) to
//     RESUME on mount and to load a tier's read-only body when a `docs` frame
//     announces it.
// It mirrors `useExplanationDraft`'s fetch-ReadableStream + drainSseFrames shape
// (the established motir-core SSE-consumer pattern) and feeds every frame through
// `normalizeFrame` into the reducer. NO planning logic lives here — motir-ai owns
// the conductor; the browser only reaches it through these two routes.
//
// Continue / Skip / the validate-early decision are CONVERSATION turns (the
// model is conversation-only — there is no doc editing and no structured advance
// endpoint): each posts a short natural-language turn the conductor reads as an
// `advance` / skip / decision. The canned phrasings come from the caller (i18n)
// so the copy stays translatable.

interface SubmitResponse {
  jobId?: string;
  code?: string;
  error?: string;
}

function mapDocs(dto: PreplanStateDTO) {
  return dto.docs.map((d) =>
    toDirectionDocView({
      kind: d.kind,
      currentBody: d.currentBody,
      currentVersion: d.currentVersion,
      // The structured per-tier summary the canvas captured-findings renders
      // (MOTIR-1225) — carried through so a resume/refresh keeps the breakdown.
      summary: d.summary,
    }),
  );
}

export interface UseDiscoveryChat {
  state: DiscoveryState;
  /** Send a free-form chat turn (the sole input). */
  send: (text: string) => void;
  /** Approve the tier under review and return to the hub (the conductor narrates
   *  + drafts the next). `approvalText` is the canned advance phrasing (i18n). */
  continueTier: (approvalText: string) => void;
  /** Skip an upcoming optional tier from the chat (the conductor advances past it). */
  skipTier: (skipText: string) => void;
  /** Answer the blocking validate-demand-first ask (MOTIR-1064). */
  decideValidateEarly: (decisionText: string) => void;
  /** Re-open a produced tier's read-only review. */
  openTier: (kind: DirectionDocKind) => void;
  /** Open the web-only full-page design step (Subtask 7.3.27 / MOTIR-1040). */
  openDesign: () => void;
  /** Enter the pre-plan → generation hand-off (Subtask 7.3.28 / MOTIR-1041) — the
   *  LAST 7.3 affordance, reachable once every tier is complete. It freezes the
   *  already-persisted pre-plan baseline as the generation input and hands off to
   *  7.4; it does NOT generate the tree. Back (the hub) keeps the baseline revisable. */
  enterGeneration: () => void;
  /** Persist the chosen design (Subtask 7.3.81): update locally at once, then PATCH
   *  /api/ai/pre-plan best-effort (a failed save keeps the local choice). */
  saveDesign: (choice: DesignChoiceDTO) => void;
  /** Leave the full-screen review / design step for the hub. */
  back: () => void;
  dismissError: () => void;
}

export interface UseDiscoveryChatOptions {
  /** The idea preserved across the auth redirect (7.3.14 cookie) — seeded as the
   *  FIRST turn for a fresh session, ignored when a session already exists. */
  initialIdea?: string | null;
  /** A discovery job the server already submitted for this session (the migrate
   *  wizard's opening turn, `MigrateOnboardingDto.discoveryJobId`). Read on mount,
   *  in place of `initialIdea`, so its question is the conversation's first turn. */
  attachJobId?: string | null;
}

export function useDiscoveryChat(options: UseDiscoveryChatOptions = {}): UseDiscoveryChat {
  const { initialIdea, attachJobId } = options;
  const [state, dispatch] = useReducer(reduceDiscovery, undefined, initialDiscoveryState);

  // One in-flight turn at a time; abort it on unmount. `mountedRef` guards every
  // post-await dispatch so a late frame never lands after teardown.
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const startedRef = useRef(false);

  // Re-read the pre-plan bodies (resume on mount; refresh after docs/revisions).
  const fetchPreplan = useCallback(async (signal: AbortSignal): Promise<PreplanStateDTO | null> => {
    const res = await fetch('/api/ai/pre-plan', {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as PreplanStateDTO;
  }, []);

  /** Read one job's SSE stream into the reducer, then pull any tier bodies it
   *  announced. Shared by a user turn and by attaching to a job the SERVER
   *  submitted (`attachJobId`). Throws a `StreamFailure` on a refused stream. */
  const readJob = useCallback(
    async (jobId: string, controller: AbortController) => {
      const streamRes = await fetch(`/api/ai/chat/${encodeURIComponent(jobId)}/stream`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!streamRes.ok || !streamRes.body) {
        const body = (await streamRes.json().catch(() => ({}))) as SubmitResponse;
        throw new StreamFailure(body.code ?? 'MOTIR_AI_UNAVAILABLE', body.error);
      }

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Kinds announced this turn whose bodies we must fetch + which to open.
      let docsAnnounced = false;
      let openKind: DirectionDocKind | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = drainSseFrames(buffer);
        buffer = rest;
        for (const { event, data } of frames) {
          // Every frame the discovery job emits (`assistant`, `state`, `docs`,
          // `revisions`, …) is a PROGRESS frame, which motir-ai nests under `data`
          // (MOTIR-10878); the job's own `status` frame passes through unchanged.
          const frame = normalizeFrame(event, unwrapProgressFrame(data));
          if (!frame || !mountedRef.current) continue;
          dispatch({ type: 'frame', frame });
          if (frame.event === 'docs') {
            docsAnnounced = true;
            openKind = frame.data.docs[frame.data.docs.length - 1]!.kind;
          } else if (frame.event === 'revisions') {
            docsAnnounced = true; // refresh affected bodies, don't auto-open (1179)
          }
        }
      }

      // A tier was (re)drafted this turn → pull its read-only body and, for a
      // freshly-drafted tier, jump into its review gate.
      if (docsAnnounced && mountedRef.current) {
        const dto = await fetchPreplan(controller.signal);
        if (dto && mountedRef.current) {
          // Thread the bodies AND the per-artifact forward revision logs + diffs
          // (7.3.71) AND the feature catalog (7.3.79): the gate renders the diffs
          // from the seam (never recomputes) + the catalog in the vision review.
          dispatch({
            type: 'docsLoaded',
            docs: mapDocs(dto),
            revisions: mapRevisions(dto),
            catalog: dto.catalog,
          });
          // A freshly-drafted tier opens its gate; a `revisions` cascade already
          // routed to its attributed tier in the reducer, so don't override it.
          if (openKind) dispatch({ type: 'openReview', kind: openKind });
        }
      }
    },
    [fetchPreplan],
  );

  const runTurn = useCallback(
    async (text: string) => {
      // Serialize turns: ignore a send while one is streaming.
      if (abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: 'userTurn', text });

      try {
        const submitRes = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: text }),
          signal: controller.signal,
        });
        const submitBody = (await submitRes.json().catch(() => ({}))) as SubmitResponse;
        if (!submitRes.ok || !submitBody.jobId) {
          throw new StreamFailure(submitBody.code ?? 'MOTIR_AI_UNAVAILABLE', submitBody.error);
        }
        await readJob(submitBody.jobId, controller);
      } catch (err) {
        if (mountedRef.current && !isAbort(err)) {
          const code = err instanceof StreamFailure ? err.code : 'MOTIR_AI_UNAVAILABLE';
          const message = err instanceof Error ? err.message : undefined;
          dispatch({ type: 'streamError', code, message });
        }
      } finally {
        abortRef.current = null;
        if (mountedRef.current) dispatch({ type: 'streamEnd' });
      }
    },
    [readJob],
  );

  /** Show the reply to a turn the SERVER submitted (MOTIR-8254: the migrate
   *  wizard's code-grounded opening turn), with no user bubble before it. A
   *  stream that cannot be read is not the person's error, so it settles
   *  quietly and leaves the composer open. */
  const attachJob = useCallback(
    async (jobId: string) => {
      if (abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: 'streamStart' });
      try {
        await readJob(jobId, controller);
      } catch {
        // quiet: the composer stays usable
      } finally {
        abortRef.current = null;
        if (mountedRef.current) dispatch({ type: 'streamEnd' });
      }
    },
    [readJob],
  );

  // Resume on mount: hydrate from the persisted pre-plan state; if there's none
  // and the visitor brought an idea (the 7.3.14 cookie), seed the first turn.
  useEffect(() => {
    mountedRef.current = true;
    if (startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();

    void (async () => {
      const dto = await fetchPreplan(controller.signal).catch(() => null);
      if (!mountedRef.current) return;
      if (dto) {
        dispatch({
          type: 'hydrate',
          session: dto.session,
          docs: mapDocs(dto),
          revisions: mapRevisions(dto),
          catalog: dto.catalog,
        });
      } else {
        // No pre-plan read (fetch failed / non-ok) — settle hydration so the
        // "Resuming…" placeholder clears and the fresh state renders (MOTIR-1487).
        dispatch({ type: 'hydrateSettled' });
      }
      const fresh = !dto || dto.session === null;
      if (attachJobId) {
        void attachJob(attachJobId);
      } else if (fresh && initialIdea && initialIdea.trim()) {
        void runTurn(initialIdea.trim());
      }
    })();

    return () => {
      mountedRef.current = false;
      controller.abort();
      abortRef.current?.abort();
    };
    // Run once on mount; runTurn/fetchPreplan are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed) void runTurn(trimmed);
    },
    [runTurn],
  );

  const continueTier = useCallback(
    (approvalText: string) => {
      dispatch({ type: 'backToHub' });
      void runTurn(approvalText);
    },
    [runTurn],
  );

  const skipTier = useCallback((skipText: string) => void runTurn(skipText), [runTurn]);
  const decideValidateEarly = useCallback(
    (decisionText: string) => void runTurn(decisionText),
    [runTurn],
  );
  const openTier = useCallback(
    (kind: DirectionDocKind) => dispatch({ type: 'openReview', kind }),
    [],
  );
  const openDesign = useCallback(() => dispatch({ type: 'openDesign' }), []);
  const enterGeneration = useCallback(() => dispatch({ type: 'enterGeneration' }), []);

  // Persist the design choice (7.3.81). Update local state OPTIMISTICALLY so the
  // step restores the pick immediately, then PATCH best-effort: a failed save
  // degrades quietly (the local choice is kept — the inline-edit-no-refresh /
  // side-effect-graceful contract). The Theme toggle is preview-only, not sent.
  const saveDesign = useCallback((choice: DesignChoiceDTO) => {
    dispatch({ type: 'setDesignChoice', choice });
    void fetch('/api/ai/pre-plan', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ designChoice: choice }),
    }).catch(() => {
      // best-effort: keep the optimistic local choice on a network failure.
    });
  }, []);

  const back = useCallback(() => dispatch({ type: 'backToHub' }), []);
  const dismissError = useCallback(() => dispatch({ type: 'dismissError' }), []);

  return {
    state,
    send,
    continueTier,
    skipTier,
    decideValidateEarly,
    openTier,
    openDesign,
    enterGeneration,
    saveDesign,
    back,
    dismissError,
  };
}

class StreamFailure extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'StreamFailure';
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
