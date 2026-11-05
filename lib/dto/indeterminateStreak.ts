// DTO for the daily health check's INDETERMINATE-STREAK read (MOTIR-10429) —
// what `system.daily-health-check` resolves to under `indeterminateStreak`, and
// therefore what lands on its `job_run.output`. Dates cross the boundary as ISO
// strings, matching `lib/dto/indexRebuildStreak.ts`.
//
// Every probe with an `indeterminate` arm is quiet on ONE such verdict, and
// deliberately: a single GHCR or GitHub blip must not page anyone (the
// MOTIR-3606 cry-wolf lesson). But a read that fails every day for a reason that
// will not clear by itself — an expired token, a revoked App installation, a
// registry path that moved — then hid the very fault the probe was added to
// find, for as long as it lasted. This read is the escalation: a probe that has
// been `indeterminate` on the last N runs fails the check, naming the probe.

/** One probe's current run of consecutive `indeterminate` verdicts. */
export interface IndeterminateStreakEntryDTO {
  /** The probe's field on `DailyHealthCheckResult` (`fleet`, `runnerImageFreshness`, …). */
  probe: string;
  /** The probe's `step.run` id — the name an operator finds in the handler. */
  step: string;
  /** How many runs in a row, this one included, read `indeterminate`. */
  consecutive: number;
  /** When the oldest run of the streak started. */
  since: string;
  /** Which read failed on THIS run. */
  phase: string;
  /** What that read said on THIS run. */
  detail: string;
}

/**
 * What this read CANNOT see, carried on every verdict for the reason
 * `INDEX_REBUILD_STREAK_BLIND_SPOT` gives: a reader who takes a green verdict
 * for more than it measured will be wrong.
 */
export const INDETERMINATE_STREAK_BLIND_SPOT =
  'A run that FAILED records no probe verdicts, so it is skipped: it neither extends nor breaks a ' +
  'streak. A streak can therefore span a day on which another probe failed the check.';

export type IndeterminateStreakVerdictDTO =
  | {
      /** No probe has reached the threshold. `streaks` names every probe that is
       *  `indeterminate` on this run, below it — readable, not an alarm. */
      verdict: 'ok';
      threshold: number;
      /** How many earlier succeeded runs were read. */
      runsRead: number;
      streaks: IndeterminateStreakEntryDTO[];
      checkedAt: string;
      blindSpot: string;
    }
  | {
      /** At least one probe has been `indeterminate` on `threshold`+ runs in a row. */
      verdict: 'persistent';
      threshold: number;
      runsRead: number;
      streaks: IndeterminateStreakEntryDTO[];
      /** The entries at or over the threshold — the actionable part. */
      offenders: IndeterminateStreakEntryDTO[];
      checkedAt: string;
      blindSpot: string;
    };
