'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useFormatter, useNow } from 'next-intl';

// A LIVE clock for relative times in client components (MOTIR-11970).
//
// `i18n/request.ts` pins next-intl's `now` once per request so the server and
// the browser agree on first paint (finding #89), and `NextIntlClientProvider`
// carries that instant to the client. `format.relativeTime(date)` with ONE
// argument measures against the pin forever: a list the browser fetches or
// appends to after load reads a just-made row as "in 3 minutes", and every
// older row stays as old as it was at load. `useRelativeTime()` is the one door
// a client component formats a relative time through instead
// (`tests/i18n/client-relative-time-guard.test.ts` keeps it that way).
//
// THE CLOCK is the pin advanced by the time that has passed in this browser
// since the pin was first OBSERVED here, in whole ticks:
//
//   now = pin + floor((Date.now() - observedAt) / TICK) * TICK
//
// - First paint is exactly the pin, so SSR and hydration agree: the server and
//   `getServerSnapshot` return the pin itself, and for the first minute after
//   the observation the client snapshot is the pin too.
// - It counts in SERVER time. Rows carry server timestamps; measuring them from
//   the server's instant plus elapsed browser time cancels any skew between the
//   two clocks, which a bare `Date.now()` would not.
// - A component that mounts long after load (a drawer opened half an hour in)
//   reads the elapsed time at once — not the pin, which a per-component
//   `useNow({ updateInterval })` would start from and hold for a whole tick.
// - ONE interval serves every subscriber on the page, rather than one per row.
//
// The root layout mounts `RelativeTimeClockAnchor` inside the provider, so the
// pin is observed when the page hydrates (and again when `router.refresh()`
// re-pins it), not when the first relative time happens to render.

/** The resolution of the live clock: labels advance once a minute. */
export const RELATIVE_TIME_TICK_MS = 60_000;
/** How often subscribers re-read the clock; a tick shows within this much of
 * falling due. The snapshot only CHANGES once a tick, so a re-read in between
 * re-renders nothing. */
const POLL_MS = 10_000;

type Clock = {
  pinMs: number;
  observedAtMs: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
};

const clocks = new Map<number, Clock>();
let latestPinMs: number | null = null;

function clockFor(pinMs: number): Clock {
  const existing = clocks.get(pinMs);
  if (existing) return existing;
  const clock: Clock = { pinMs, observedAtMs: Date.now(), listeners: new Set(), timer: null };
  clocks.set(pinMs, clock);
  latestPinMs = pinMs;
  // A re-pin (router.refresh) leaves the older instant behind: drop every clock
  // nothing is subscribed to any more. The LATEST one is kept even when idle —
  // it holds the observation a later mount measures its elapsed time from.
  for (const [ms, c] of clocks) {
    if (ms !== pinMs && c.listeners.size === 0) clocks.delete(ms);
  }
  return clock;
}

function snapshot(clock: Clock): number {
  const elapsed = Math.max(0, Date.now() - clock.observedAtMs);
  return clock.pinMs + Math.floor(elapsed / RELATIVE_TIME_TICK_MS) * RELATIVE_TIME_TICK_MS;
}

function subscribe(clock: Clock, listener: () => void): () => void {
  clock.listeners.add(listener);
  clock.timer ??= setInterval(() => {
    for (const l of clock.listeners) l();
  }, POLL_MS);
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size > 0) return;
    // The last subscriber leaving: the interval its first one started is live.
    clearInterval(clock.timer!);
    clock.timer = null;
    if (clock.pinMs !== latestPinMs) clocks.delete(clock.pinMs);
  };
}

const isServer = typeof window === 'undefined';

/** Record when this browser first saw `pinMs` (no-op on the server). */
export function observeRelativeTimePin(pinMs: number): void {
  if (!isServer) clockFor(pinMs);
}

/**
 * The live instant relative times are measured against: the provider's pinned
 * `now` on the server and on first paint, advancing a tick at a time after.
 */
export function useLiveNow(): Date {
  const pinMs = useNow().getTime();
  const clock = isServer ? null : clockFor(pinMs);
  // On the server React reads only the third argument, so the first two —
  // the only readers of `clock` — never run there with it null.
  const subscribeToClock = useCallback(
    (listener: () => void) => subscribe(clock!, listener),
    [clock],
  );
  const nowMs = useSyncExternalStore(
    subscribeToClock,
    () => snapshot(clock!),
    () => pinMs,
  );
  return useMemo(() => new Date(nowMs), [nowMs]);
}

/**
 * `relativeTime(value)` measured against the live clock. A value AFTER the
 * clock — a row written since the last tick, or a server clock slightly ahead —
 * reads as now, never as a future time.
 */
export function useRelativeTime(): (value: Date | number | string) => string {
  const format = useFormatter();
  const now = useLiveNow();
  return useCallback(
    (value: Date | number | string) => {
      const date = value instanceof Date ? value : new Date(value);
      return format.relativeTime(date > now ? now : date, now);
    },
    [format, now],
  );
}

/** Test seam: forget every observation, as a fresh page load would. */
export function resetRelativeTimeClockForTests(): void {
  for (const c of clocks.values()) if (c.timer) clearInterval(c.timer);
  clocks.clear();
  latestPinMs = null;
}
