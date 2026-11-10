import { vi } from 'vitest';

/**
 * Freeze the wall clock the fixed-window limiter reads, so every counted call a
 * case makes lands in ONE window cell however long the calls take (MOTIR-10807).
 *
 * ── Why aligning was not enough ─────────────────────────────────────────────
 * `waitForWindowBoundary` (`rateLimitWindow.ts`) hands a case a whole
 * `ALIGNED_WINDOW_MS` cell, which is ~105× the counted span MEASURED on a quiet
 * machine. It is still a margin against the wall clock, and a loaded CI shard
 * spends it from both ends: the `setTimeout` that aligns can fire late, landing
 * the case anywhere in the next cell, and each counted call costs as much as the
 * shard's Postgres makes it. On motir-core#4081 (run 42604244157) the same shard
 * timed a single counter `INSERT` out at 250 ms, and `does NOT pool two tokens
 * of the same user into one budget` read `expected 200 to be 429` — its third
 * request counted as the first of a fresh cell. Reproduced locally by slowing
 * each increment to 800 ms: the same assertion, the same message, no degraded
 * decision anywhere in the run.
 *
 * A frozen clock removes the class instead of lowering its odds: every
 * `Date.now()` the limiter, the test and the counter's `windowStart` read
 * returns the same instant, so no boundary can fall between two calls.
 *
 * ── What it fakes, and what it leaves alone ─────────────────────────────────
 * ONLY `Date`. Timers stay real, so the store deadline (`postgresStore.ts`'s
 * `setTimeout`), the database driver and every `sleep` keep running. Frozen at
 * the real current instant, so a token's expiry and every other "is it still
 * valid" comparison read the same answer as on the real clock.
 *
 * A case that needs the NEXT cell moves the clock itself — `vi.setSystemTime`,
 * past the reset the response advertised — which is deterministic where a real
 * sleep across the boundary is not.
 *
 * Undo with `vi.useRealTimers()` in `afterEach`, BEFORE anything that measures
 * time with `Date`.
 *
 * ⚠️ Kept out of `rateLimitWindow.ts` on purpose: that module is imported by a
 * Playwright spec (`tests/two-instance/limits.spec.ts`), which cannot load
 * `vitest`. The alignment guard (`rate-limit-window-alignment.test.ts`) counts a
 * call of this helper as securing the window, the same as an alignment wait.
 *
 * @returns the frozen instant, in epoch milliseconds.
 */
export function freezeWindowClock(): number {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now });
  return now;
}
