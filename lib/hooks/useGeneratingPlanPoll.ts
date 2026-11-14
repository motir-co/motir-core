'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchPlanReview, fetchPlanReviewSince } from '@/lib/planning/planReviewClient';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { mergePlanReview } from '@/lib/planning/mergePlanReview';
import {
  useLiveSignal,
  useLiveSignalSource,
  type LiveSignal,
  type LiveTopic,
} from '@/lib/live/liveSignal';
import { POLL_MS } from '@/lib/live/sources/planPollSource';

// THE generating-plan poll (Subtask MOTIR-6295) — the ONE place a `generating`
// Plan is watched while it is being written. Lifted out of the two effects that
// each carried a private copy of it: the plan page's live poll (`PlanDetail`) and
// the onboarding reveal (`usePlanGeneration`); the planning surface
// (`usePlanChangeConversation`) is its third caller.
//
// ⚠️ THE TRANSPORT IS THE REVIEW READ (`GET /api/plans/[id]` via
// `fetchPlanReview`), never a job stream: it is the only live read an
// MCP-authored plan has, and it is the same read every review surface settles
// through, so what the poll shows and what the gate later confirms cannot be two
// different shapes.
//
// ⚠️ SNAPSHOT SEMANTICS. `PlanItem` carries no `updatedAt`, and the plan's
// `lastActivityAt` (MOTIR-7822) says only WHEN something last happened, not WHAT —
// so there is no delta on the wire, and each response is the WHOLE truth (its
// `lastActivityAt` and `inFlightSteps` included). A proposal withdrawn between two
// ticks disappears on the next one and cannot come back from a cache.
//
// ⚠️ AND IT IS MERGED BY IDENTITY, NOT FILED WHOLE (Story MOTIR-8539 ·
// MOTIR-8575). `mergePlanReview` keeps every previous object the new snapshot
// equals, so an unchanged proposal keeps its object and its rendered node. An
// answer that changes NOTHING is not applied at all — no `version`, no
// `onSnapshot` — and `version` moves only when the proposals did, so the plan tree
// is handed no new props for a read that moved nothing it draws. Responses are applied in ISSUE order: a monotonic sequence drops any
// response older than the last one applied, so a slow early read can never
// overwrite a later snapshot. A failed or aborted tick keeps the last snapshot
// and simply retries on the next.
//
// ⚠️ NO READ STARTS BEHIND ANOTHER (MOTIR-8102). The interval is a cadence, not
// a promise: a tick that finds a read still out does NOT issue a second one. The
// review read is the heaviest the planning surface makes (the whole plan, every
// proposal's body, the narration window), so on a long plan it can outlast
// {@link POLL_MS}; issuing a fresh read every interval anyway queued a second,
// then a third, each as slow as the first, and the page slowed itself down. A read
// still out after {@link STALL_MS} is a stalled one, not a slow one: it is aborted
// (and counted as a failure, so `failing` reports it) and the next tick reads
// again, so one hung request can never freeze the poll. `refresh()` is the
// deliberate exception — an explicit nudge reads NOW even over a read in flight;
// the sequence guard above still drops whichever answer is older.
//
// ⚠️ AN UNCHANGED PLAN IS ANSWERED IN A FEW BYTES (MOTIR-8127). Every full response carries the
// plan's `reviewVersion`; the next tick sends it back as `?since=`, and while nothing the review
// shows has moved the server answers `{ unchanged: true }` instead of re-reading and re-sending the
// whole plan. An unchanged answer keeps the snapshot (the clock reading stays right: the progress
// line advances `observedAt` by how long the client has held it) and does NOT fire `onSnapshot` or
// bump `version`. Two reads are always FULL: a forced `refresh()`, and every
// {@link FULL_READ_EVERY}th poll — the version covers what the plan's own tables hold, and not a
// committed card a `modify`/`remove` proposal points at being renamed or moved, so that backstop
// bounds how long the snapshot can disagree with it.
//
// It stops — and aborts what is in flight — when a snapshot's status is no
// longer `generating`, when `planId` changes, or on unmount. A `null` planId is
// "nothing to watch".
//
// ⚠️ THE CADENCE IS A PLAN FRAME ON THE TAB'S ONE STREAM (Story MOTIR-8542 ·
// Subtask MOTIR-8732), through the live-signal seam (MOTIR-8572). Under the
// shell's provider a `plan` signal arrives when the server saw the plan's review
// version move, on reconnect catch-up, and as the stream's 60 s `full` backstop;
// `refresh()` asks the source to `trigger` a FORCED signal. The 2.5 s interval
// survives in two places only: as the no-provider fallback
// (`lib/live/sources/planPollSource.ts`, whose ticks are marked `cadence`), and as
// the ONE retry a failed read schedules when nothing else is coming. Everything
// above this paragraph is the READ POLICY and stays here, because it is not a
// transport.
//
// ⚠️ A PUSH SIGNAL IS NEVER DROPPED. A cadence tick that finds a read out may be
// skipped, because the next tick catches up. A push signal has no next tick, so
// one that finds a read out marks the plan DIRTY and exactly one more read runs
// when that read settles — otherwise a frame landing mid-read would leave the
// snapshot stale until the backstop. A `full` signal reads without `?since=`.
//
// It draws NOTHING. Callers decide what a snapshot means: `onSnapshot` fires
// with every applied response, in the same tick it lands, for callers whose own
// state must move with it (the plan page's `review`, the reveal's `items`).

/** The generating-plan poll cadence — owned by the seam's plan source, re-exported here. */
export { POLL_MS };

/** A read still out after this long is abandoned so the poll can read again (MOTIR-8102). */
export const STALL_MS = 15_000;

/** Every Nth poll is a FULL read even when the version says unchanged (MOTIR-8127). */
export const FULL_READ_EVERY = 8;

/** Consecutive failed reads after which the poll reports `failing`. */
export const FAILING_AFTER = 3;

export interface GeneratingPlanPollOptions {
  /** Read once immediately, before the first interval (default `true`). The plan
   *  page seeds from the server read, so it waits a full interval, as it always has. */
  immediate?: boolean;
  /**
   * Called with every APPLIED snapshot that changed something (a stale, failed or
   * identical read never reaches it), MERGED into the previous one — so a consumer
   * that stores it keeps the kept references. The second argument says whether the
   * proposals moved, and which (MOTIR-8575).
   */
  onSnapshot?: (
    review: PlanReviewDto,
    change: { itemsChanged: boolean; changedItemIds: ReadonlySet<string> },
  ) => void;
}

export interface GeneratingPlanPoll {
  /** The latest applied snapshot of the plan being polled, or `null` before the
   *  first one (and whenever `planId` is `null`). */
  review: PlanReviewDto | null;
  /** Bumped on every applied snapshot whose proposals changed (MOTIR-8575). */
  version: number;
  /**
   * Bumped on every ANSWERED read — a full snapshot and an `unchanged` answer
   * alike — and never on a failed, aborted, stale or dropped one (MOTIR-11254).
   * It is the token that says a read ARRIVED: the snapshot cannot be, because
   * `mergePlanReview` keeps every equal reference and an unchanged answer files
   * nothing, so two reads in a row can hand down the very same objects. The
   * planner cue's two-read hold (`lib/planning/cueState.ts`) counts by it.
   */
  reads: number;
  /** `true` after {@link FAILING_AFTER} consecutive failed reads; `false` again on
   *  the next success. The last good snapshot is kept throughout. */
  failing: boolean;
  /** Read NOW, out of cadence (the reveal's stream nudge). A no-op while nothing
   *  is being polled. */
  refresh: () => void;
}

/** A topic no subscription is ever made for (`enabled` is false whenever it is used). */
const IDLE_TOPIC: LiveTopic = { kind: 'plan', planId: '' };

interface Snapshot {
  planId: string;
  review: PlanReviewDto;
}

export function useGeneratingPlanPoll(
  planId: string | null,
  opts: GeneratingPlanPollOptions = {},
): GeneratingPlanPoll {
  const immediate = opts.immediate ?? true;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [version, setVersion] = useState(0);
  const [reads, setReads] = useState(0);
  // Keyed by plan, so a `planId` change reads as "not failing" without a reset.
  const [failingFor, setFailingFor] = useState<string | null>(null);

  // The latest callback, without re-starting the poll when a caller re-renders.
  const onSnapshotRef = useRef(opts.onSnapshot);
  useEffect(() => {
    onSnapshotRef.current = opts.onSnapshot;
  });
  // A signal from the seam, or `undefined` for a read NOW (a source that cannot be nudged).
  const tickRef = useRef<((signal?: LiveSignal) => void) | null>(null);
  // The plan a snapshot STOPPED (no longer `generating`): its cadence unsubscribes.
  const [stoppedPlanId, setStoppedPlanId] = useState<string | null>(null);

  useEffect(() => {
    if (!planId) return;
    let stopped = false;
    let issued = 0;
    let applied = 0;
    let failures = 0;
    // The version of the last FULL snapshot applied, and how many unchanged answers followed it.
    let heldVersion: string | null = null;
    let unchangedRun = 0;
    // The snapshot held for THIS plan — what the next full answer merges into.
    let held: PlanReviewDto | null = null;
    // Each read's controller, with when it started: a tick skips while one is out.
    const inFlight = new Map<AbortController, number>();
    // A push signal that found a read out: one more read when it settles (full if any asked).
    let dirty = false;
    let dirtyFull = false;
    // Whether a timer cadence drives this poll — then a failure needs no retry of its own.
    let cadenced = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const clearRetry = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const stop = () => {
      stopped = true;
      clearRetry();
      dirty = false;
      for (const ctrl of inFlight.keys()) ctrl.abort();
      inFlight.clear();
      if (tickRef.current === tick) tickRef.current = null;
    };

    // `force` is an explicit `refresh()`: it reads even over one in flight. A push
    // signal (`push`) that finds a read out marks the plan dirty instead of being
    // lost; `full` skips `?since=`.
    const tick = (force = false, mode: { push?: boolean; full?: boolean } = {}) => {
      if (stopped) return;
      if (!force) {
        // A read out past the stall bound is abandoned, so a hung request cannot freeze the cadence.
        const now = Date.now();
        for (const [out, startedAt] of inFlight) {
          if (now - startedAt >= STALL_MS) {
            out.abort();
            inFlight.delete(out);
          }
        }
        // Still a read out: do not start another behind it (MOTIR-8102).
        if (inFlight.size > 0) {
          if (mode.push) {
            dirty = true;
            if (mode.full) dirtyFull = true;
          }
          return;
        }
      }
      clearRetry();
      const seq = ++issued;
      const ctrl = new AbortController();
      inFlight.set(ctrl, Date.now());
      // A forced read, a first read and the periodic backstop are FULL; the rest ask "changed since?".
      const since =
        !force && !mode.full && heldVersion && unchangedRun < FULL_READ_EVERY - 1
          ? heldVersion
          : null;
      void (
        since
          ? fetchPlanReviewSince(planId, since, ctrl.signal)
          : fetchPlanReview(planId, ctrl.signal)
      )
        .then((answer) => {
          // Dropped: the poll stopped, or a LATER read has already been applied.
          if (stopped || seq <= applied) return;
          applied = seq;
          failures = 0;
          setFailingFor(null);
          setReads((n) => n + 1);
          if ('unchanged' in answer) {
            // Nothing moved: the snapshot, `version` and `onSnapshot` all stand.
            unchangedRun += 1;
            return;
          }
          heldVersion = answer.reviewVersion ?? null;
          unchangedRun = 0;
          const merged = mergePlanReview(held, answer);
          const review = merged.review;
          if (review !== held) {
            held = review;
            setSnapshot({ planId, review });
            if (merged.itemsChanged) setVersion((v) => v + 1);
            onSnapshotRef.current?.(review, {
              itemsChanged: merged.itemsChanged,
              changedItemIds: merged.changedItemIds,
            });
          }
          if (review.status !== 'generating') {
            stop();
            setStoppedPlanId(planId);
          }
        })
        .catch(() => {
          // Best-effort — the last snapshot stands and the next tick retries. A
          // failure older than an applied success says nothing about now.
          if (stopped || seq <= applied) return;
          failures += 1;
          if (failures >= FAILING_AFTER) setFailingFor(planId);
          // With no cadence, nothing else would read again until the next frame:
          // retry once, so `failing` still reports a plan that cannot be read.
          if (!cadenced && retryTimer === null) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              tick(false, { push: true });
            }, POLL_MS);
          }
        })
        .finally(() => {
          inFlight.delete(ctrl);
          if (dirty && !stopped && inFlight.size === 0) {
            const full = dirtyFull;
            dirty = false;
            dirtyFull = false;
            tick(false, { push: true, full });
          }
        });
    };

    tickRef.current = (signal) => {
      if (!signal) return tick(true);
      if (signal.cadence) {
        // A timer drives this poll: its next tick is the retry.
        cadenced = true;
        clearRetry();
      }
      tick(signal.forced === true, { push: !signal.cadence, full: signal.full === true });
    };
    if (immediate) tick();
    return stop;
  }, [planId, immediate]);

  // The cadence, from the seam: each signal is "time to look", and a FORCED one
  // is the explicit `refresh()` below. The tick decides whether looking reads.
  const topic = useMemo<LiveTopic | null>(
    () => (planId ? { kind: 'plan', planId } : null),
    [planId],
  );
  useLiveSignal(topic ?? IDLE_TOPIC, (signal) => tickRef.current?.(signal), {
    enabled: topic !== null && stoppedPlanId !== planId,
  });

  // ⚠️ `refresh` IS STABLE FOR THE HOOK'S LIFETIME, as it was before the seam: the
  // source and topic are read through refs. A caller may hold it in an effect's
  // deps (`usePlanGeneration`'s `start`, which `GenerationFlow` auto-starts on), and
  // an identity that moved with `planId` re-ran that effect when the plan settled,
  // starting generation over again.
  const source = useLiveSignalSource();
  const sourceRef = useRef(source);
  const topicRef = useRef(topic);
  useEffect(() => {
    sourceRef.current = source;
    topicRef.current = topic;
  });
  const refresh = useCallback(() => {
    const current = topicRef.current;
    if (!current || !tickRef.current) return;
    // A source that cannot be nudged still reads now: the read policy is ours.
    const live = sourceRef.current;
    if (live.trigger) live.trigger(current);
    else tickRef.current();
  }, []);

  const current = planId && snapshot && snapshot.planId === planId ? snapshot.review : null;
  return {
    review: current,
    version,
    reads,
    failing: !!planId && failingFor === planId,
    refresh,
  };
}
